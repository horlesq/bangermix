//! bangermix audio engine: up to four decks, a DJ mixer, sync, loops, slip and beat FX.
//!
//! The engine is driven by parameters ([`Engine::set`]) and renders blocks
//! ([`Engine::render`]). Rendering never allocates, frees or locks, so a platform
//! audio callback (an AudioWorklet on the web) can call it directly. Loading a track
//! allocates once ([`Engine::load_begin`]), then copies chunks in ([`Engine::load_push`]),
//! so a long track can be moved onto the audio thread a little at a time.
//!
//! Each block it writes a snapshot of the decks and meters into [`Engine::state`],
//! which the interface reads to draw.

mod deck;
pub mod fx;
pub mod param;

use bm_dsp::{Limiter, Smoothed};
pub use deck::Track;
use deck::{Deck, MasterClock};
use fx::BeatFx;
use param::*;

/// Most decks the engine plays.
pub const MAX_DECKS: usize = 4;
/// Largest block [`Engine::render`] takes.
pub const MAX_BLOCK: usize = 1024;
/// Values per deck in [`Engine::state`].
pub const DECK_STATE: usize = 16;
/// Where the global values start in [`Engine::state`].
pub const GLOBAL_STATE: usize = MAX_DECKS * DECK_STATE;
pub const STATE_LEN: usize = GLOBAL_STATE + 16;
/// How fast meters fall: to this fraction of their level per second.
const METER_FALL_PER_S: f32 = 0.03;

pub struct Engine {
    sample_rate: f64,
    decks: Vec<Deck>,
    master_gain: Smoothed,
    phones_gain: Smoothed,
    cue_mix: Smoothed,
    limiter: Limiter,
    fx: BeatFx,
    master_peak: [f32; 2],
    phones_peak: [f32; 2],
    frames: u64,
    /// Snapshot for the interface; see `DECK_*` and `G_*` in [`param`].
    pub state: [f64; STATE_LEN],
}

impl Engine {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            sample_rate,
            decks: (0..MAX_DECKS).map(|_| Deck::new(sample_rate)).collect(),
            master_gain: Smoothed::new(1.0, sample_rate, 0.01),
            phones_gain: Smoothed::new(0.8, sample_rate, 0.01),
            cue_mix: Smoothed::new(0.0, sample_rate, 0.01),
            limiter: Limiter::new(sample_rate),
            fx: BeatFx::new(sample_rate),
            master_peak: [0.0; 2],
            phones_peak: [0.0; 2],
            frames: 0,
            state: [0.0; STATE_LEN],
        }
    }

    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    /// Sets parameter `param` of deck `deck` (or a global one with [`GLOBAL`]).
    pub fn set(&mut self, deck: u32, param: u32, value: f64) {
        if deck == GLOBAL {
            match param {
                G_MASTER_GAIN => self.master_gain.target = value as f32,
                G_CUE_MIX => self.cue_mix.target = value.clamp(0.0, 1.0) as f32,
                G_PHONES_GAIN => self.phones_gain.target = value as f32,
                G_FX_TYPE..=G_FX_PARAM => self.fx.set(param, value),
                _ => {}
            }
        } else if let Some(d) = self.decks.get_mut(deck as usize) {
            d.set(param, value);
        }
    }

    /// Starts loading a track of `frames` frames at `rate` Hz onto `deck`, replacing
    /// what was there. Allocates; the deck stops.
    pub fn load_begin(&mut self, deck: u32, frames: usize, rate: f64) {
        if let Some(d) = self.decks.get_mut(deck as usize) {
            d.load(Track::with_capacity(frames, rate));
        }
    }

    /// Appends the next chunk of the track being loaded onto `deck`.
    pub fn load_push(&mut self, deck: u32, left: &[f32], right: &[f32]) {
        if let Some(Some(t)) = self.decks.get_mut(deck as usize).map(|d| d.track.as_mut()) {
            t.push(left, right);
        }
    }

    pub fn unload(&mut self, deck: u32) {
        if let Some(d) = self.decks.get_mut(deck as usize) {
            d.unload();
        }
    }

    /// Renders `n` frames (at most [`MAX_BLOCK`]) into the four outputs: master left
    /// and right, headphones left and right.
    pub fn render(&mut self, master: [&mut [f32]; 2], phones: [&mut [f32]; 2]) {
        let [ml, mr] = master;
        let [pl, pr] = phones;
        let n = ml
            .len()
            .min(mr.len())
            .min(pl.len())
            .min(pr.len())
            .min(MAX_BLOCK);
        let block_s = n as f64 / self.sample_rate;

        // The master deck's clock, read once per block, drives every synced deck.
        let clock = self
            .decks
            .iter()
            .find(|d| d.master && d.has_grid())
            .map(Deck::clock)
            .unwrap_or(MasterClock::NONE);
        for d in &mut self.decks {
            d.begin_block(&clock, block_s);
        }
        self.fx.begin_block(clock.bpm);

        let fall = METER_FALL_PER_S.powf(block_s as f32);
        for p in self.master_peak.iter_mut().chain(&mut self.phones_peak) {
            *p *= fall;
        }
        for d in &mut self.decks {
            d.peak[0] *= fall;
            d.peak[1] *= fall;
        }

        let fx_target = self.fx.target();
        for i in 0..n {
            let (mut sum_l, mut sum_r, mut cue_l, mut cue_r) = (0.0, 0.0, 0.0, 0.0);
            for (k, d) in self.decks.iter_mut().enumerate() {
                let out = d.next_frame();
                let (mut l, mut r) = out.as_ref().map_or((0.0, 0.0), |o| o.main);
                if fx_target == k as u32 {
                    // Even when the deck is silent, so an echo rings out.
                    (l, r) = self.fx.process(l, r);
                }
                sum_l += l;
                sum_r += r;
                if let (true, Some(out)) = (d.cue, out) {
                    cue_l += out.pre_fader.0;
                    cue_r += out.pre_fader.1;
                }
            }
            if fx_target == fx::TARGET_MASTER {
                (sum_l, sum_r) = self.fx.process(sum_l, sum_r);
            }
            let g = self.master_gain.tick();
            let (l, r) = self.limiter.process(sum_l * g, sum_r * g);
            ml[i] = l;
            mr[i] = r;
            self.master_peak[0] = self.master_peak[0].max(l.abs());
            self.master_peak[1] = self.master_peak[1].max(r.abs());

            let mix = self.cue_mix.tick();
            let pg = self.phones_gain.tick();
            let hl = ((cue_l * (1.0 - mix) + l * mix) * pg).clamp(-1.0, 1.0);
            let hr = ((cue_r * (1.0 - mix) + r * mix) * pg).clamp(-1.0, 1.0);
            pl[i] = hl;
            pr[i] = hr;
            self.phones_peak[0] = self.phones_peak[0].max(hl.abs());
            self.phones_peak[1] = self.phones_peak[1].max(hr.abs());
        }
        self.frames += n as u64;
        self.write_state();
    }

    fn write_state(&mut self) {
        for (k, d) in self.decks.iter().enumerate() {
            d.write_state(&mut self.state[k * DECK_STATE..(k + 1) * DECK_STATE]);
        }
        let g = &mut self.state[GLOBAL_STATE..];
        g[S_MASTER_PEAK_L] = self.master_peak[0] as f64;
        g[S_MASTER_PEAK_R] = self.master_peak[1] as f64;
        g[S_PHONES_PEAK_L] = self.phones_peak[0] as f64;
        g[S_PHONES_PEAK_R] = self.phones_peak[1] as f64;
        g[S_LIMITER_GAIN] = self.limiter.gain() as f64;
        g[S_FRAMES] = self.frames as f64;
    }

    /// Reads one deck's value from the state snapshot.
    pub fn deck_state(&self, deck: usize, value: usize) -> f64 {
        self.state[deck * DECK_STATE + value]
    }
}

#[cfg(test)]
mod tests;
