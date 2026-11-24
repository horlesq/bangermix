//! Beat FX: one effect unit, synced to the master tempo, on one channel or the master.
//!
//! Echo and reverb are sends: switching them off stops feeding them, and the tail
//! rings out (an "echo out"). Flanger and roll fade in and out.

use crate::param::*;
use bm_dsp::Smoothed;
use std::f64::consts::{PI, TAU};

pub const OFF: u32 = 0;
pub const ECHO: u32 = 1;
pub const REVERB: u32 = 2;
pub const FLANGER: u32 = 3;
pub const ROLL: u32 = 4;
/// The FX target that means the master output.
pub const TARGET_MASTER: u32 = 4;

/// Longest echo or roll.
const MAX_DELAY_S: f64 = 4.0;
/// Tempo the FX follow when there is no master deck.
const DEFAULT_BPM: f64 = 120.0;

pub struct BeatFx {
    sr: f64,
    kind: u32,
    target: u32,
    beats: f64,
    wet: f32,
    on: bool,
    param: f32,
    bpm: f64,
    send: Smoothed,
    mix: Smoothed,
    buf: [Vec<f32>; 2],
    w: usize,
    delay: f64,
    tone: [Tone; 2],
    reverb: [Reverb; 2],
    lfo: f64,
    roll_start: usize,
    roll_len: usize,
    roll_pos: usize,
}

impl BeatFx {
    pub fn new(sr: f64) -> Self {
        let len = (MAX_DELAY_S * sr) as usize + 4;
        Self {
            sr,
            kind: OFF,
            target: TARGET_MASTER,
            beats: 0.75,
            wet: 0.6,
            on: false,
            param: 0.5,
            bpm: DEFAULT_BPM,
            send: Smoothed::new(0.0, sr, 0.005),
            mix: Smoothed::new(0.0, sr, 0.01),
            buf: [vec![0.0; len], vec![0.0; len]],
            w: 0,
            delay: sr * 0.5,
            tone: [Tone::new(sr), Tone::new(sr)],
            reverb: [Reverb::new(sr, 0), Reverb::new(sr, 23)],
            lfo: 0.0,
            roll_start: 0,
            roll_len: 1,
            roll_pos: 0,
        }
    }

    /// The deck index the unit works on, [`TARGET_MASTER`], or something no deck has
    /// when it is off.
    pub fn target(&self) -> u32 {
        if self.kind == OFF {
            u32::MAX
        } else {
            self.target
        }
    }

    pub fn set(&mut self, param: u32, value: f64) {
        match param {
            G_FX_TYPE => {
                let kind = value as u32;
                if kind != self.kind {
                    self.kind = kind;
                    self.clear();
                }
            }
            G_FX_TARGET => self.target = value as u32,
            G_FX_BEATS => self.beats = value.clamp(1.0 / 32.0, 16.0),
            G_FX_WET => self.wet = value.clamp(0.0, 1.0) as f32,
            G_FX_PARAM => self.param = value.clamp(0.0, 1.0) as f32,
            G_FX_ON => {
                let on = value > 0.5;
                if on && !self.on && self.kind == ROLL {
                    self.roll_start = self.w;
                    self.roll_pos = 0;
                }
                self.on = on;
            }
            _ => {}
        }
    }

    fn clear(&mut self) {
        for b in &mut self.buf {
            b.fill(0.0);
        }
        for r in &mut self.reverb {
            r.clear();
        }
    }

    fn beat_frames(&self) -> f64 {
        60.0 / self.bpm * self.sr
    }

    pub fn begin_block(&mut self, master_bpm: f64) {
        self.bpm = if master_bpm > 1.0 {
            master_bpm
        } else {
            DEFAULT_BPM
        };
        let on = if self.on { 1.0 } else { 0.0 };
        self.send.target = on;
        self.mix.target = on;
        let max = (self.buf[0].len() - 4) as f64;
        self.roll_len = (self.beats * self.beat_frames()).clamp(64.0, max) as usize;
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let send = self.send.tick();
        let mix = self.mix.tick();
        let len = self.buf[0].len();
        let out = match self.kind {
            ECHO => {
                // The delay glides to a new length rather than jumping (no clicks).
                let target = (self.beats * self.beat_frames()).clamp(16.0, (len - 4) as f64);
                self.delay += (target - self.delay) * 0.0005;
                let feedback = 0.3 + 0.65 * self.param;
                let mut out = [l, r];
                for (ch, x) in [l, r].into_iter().enumerate() {
                    let d = read(&self.buf[ch], self.w, self.delay);
                    let fed = x * send + self.tone[ch].process(d) * feedback;
                    self.buf[ch][self.w] = fed;
                    out[ch] = x + d * self.wet;
                }
                out
            }
            REVERB => {
                let size = 0.7 + 0.28 * self.param;
                let wl = self.reverb[0].process(l * send, size);
                let wr = self.reverb[1].process(r * send, size);
                [l + wl * self.wet, r + wr * self.wet]
            }
            FLANGER => {
                let period = (self.beats.max(0.25) * 8.0) * self.beat_frames();
                self.lfo = (self.lfo + 1.0 / period).fract();
                let ms = 1.0 + 4.0 * (0.5 - 0.5 * (TAU * self.lfo).cos());
                let d = ms * 0.001 * self.sr;
                let feedback = 0.7 * self.param;
                let mut out = [l, r];
                for (ch, x) in [l, r].into_iter().enumerate() {
                    let delayed = read(&self.buf[ch], self.w, d);
                    self.buf[ch][self.w] = x + delayed * feedback;
                    let wet = mix * self.wet;
                    out[ch] = x * (1.0 - 0.5 * wet) + delayed * 0.5 * wet;
                }
                out
            }
            ROLL => {
                // The first pass plays (and records) live; later passes repeat it.
                let recording = !self.on || self.roll_pos < self.roll_len;
                if recording {
                    self.buf[0][self.w] = l;
                    self.buf[1][self.w] = r;
                }
                let at = (self.roll_start + self.roll_pos % self.roll_len) % len;
                if self.on {
                    self.roll_pos += 1;
                }
                let wet = mix * self.wet.max(0.5);
                [
                    l * (1.0 - wet) + self.buf[0][at] * wet,
                    r * (1.0 - wet) + self.buf[1][at] * wet,
                ]
            }
            _ => [l, r],
        };
        if self.kind != ROLL || !self.on || self.roll_pos <= self.roll_len {
            self.w = (self.w + 1) % len;
        }
        (out[0], out[1])
    }
}

/// The ring buffer `d` frames before the write position, linearly interpolated.
#[inline]
fn read(buf: &[f32], w: usize, d: f64) -> f32 {
    let len = buf.len();
    let pos = w as f64 + len as f64 - d;
    let i = pos.floor();
    let t = (pos - i) as f32;
    let i = i as usize;
    let a = buf[i % len];
    let b = buf[(i + 1) % len];
    a + (b - a) * t
}

/// One-pole high-pass (200 Hz) and low-pass (5 kHz) in the echo's feedback path, so
/// repeats thin out like a DJ mixer's echo (from double-drop's `EchoTone`).
struct Tone {
    hp_coef: f32,
    lp_coef: f32,
    hp_in: f32,
    hp_out: f32,
    lp_out: f32,
}

impl Tone {
    fn new(sr: f64) -> Self {
        let rc = 1.0 / (2.0 * PI * 200.0);
        let dt = 1.0 / sr;
        Self {
            hp_coef: (rc / (rc + dt)) as f32,
            lp_coef: (1.0 - (-2.0 * PI * 5000.0 / sr).exp()) as f32,
            hp_in: 0.0,
            hp_out: 0.0,
            lp_out: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        self.hp_out = self.hp_coef * (self.hp_out + x - self.hp_in);
        self.hp_in = x;
        self.lp_out += (self.hp_out - self.lp_out) * self.lp_coef;
        self.lp_out
    }
}

/// A small Schroeder/Freeverb-style reverb: four damped combs into two all-passes.
struct Reverb {
    combs: [Comb; 4],
    allpasses: [Allpass; 2],
}

impl Reverb {
    /// `spread` offsets the delay lengths, so left and right differ.
    fn new(sr: f64, spread: usize) -> Self {
        let scale = sr / 44_100.0;
        let len = |n: usize| ((n + spread) as f64 * scale) as usize;
        Self {
            combs: [
                Comb::new(len(1116)),
                Comb::new(len(1277)),
                Comb::new(len(1422)),
                Comb::new(len(1557)),
            ],
            allpasses: [Allpass::new(len(556)), Allpass::new(len(341))],
        }
    }

    fn clear(&mut self) {
        for c in &mut self.combs {
            c.buf.fill(0.0);
        }
        for a in &mut self.allpasses {
            a.buf.fill(0.0);
        }
    }

    #[inline]
    fn process(&mut self, x: f32, size: f32) -> f32 {
        let input = x * 0.15;
        let mut y = 0.0;
        for c in &mut self.combs {
            y += c.process(input, size);
        }
        for a in &mut self.allpasses {
            y = a.process(y);
        }
        y
    }
}

struct Comb {
    buf: Vec<f32>,
    i: usize,
    store: f32,
}

impl Comb {
    fn new(len: usize) -> Self {
        Self {
            buf: vec![0.0; len.max(1)],
            i: 0,
            store: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, x: f32, feedback: f32) -> f32 {
        let y = self.buf[self.i];
        self.store = y * 0.8 + self.store * 0.2;
        self.buf[self.i] = x + self.store * feedback;
        self.i = (self.i + 1) % self.buf.len();
        y
    }
}

struct Allpass {
    buf: Vec<f32>,
    i: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Self {
            buf: vec![0.0; len.max(1)],
            i: 0,
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let b = self.buf[self.i];
        let y = b - x;
        self.buf[self.i] = x + b * 0.5;
        self.i = (self.i + 1) % self.buf.len();
        y
    }
}
