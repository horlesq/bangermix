//! A deck and its mixer channel.

use crate::color::ColorFx;
use crate::param::*;
use crate::stretch::Stretcher;
use bm_dsp::{sample_at, Isolator, Smoothed};

/// Jumps (seeks, loop wraps) crossfade from the old place to the new over this long.
const JUMP_FADE_S: f64 = 0.003;
/// Starting and stopping fade in and out over this long, so they don't click.
const PLAY_FADE_S: f64 = 0.004;
/// The platter follows the hand with this time constant: mouse and jog wheel moves
/// arrive in steps, and the sound must not.
const SCRATCH_SMOOTH_S: f64 = 0.02;
/// A synced deck closes a gap to the master's beat over about this long...
const SYNC_CORRECT_S: f64 = 0.5;
/// ...at most this much faster or slower (1%: not heard as a pitch change).
const SYNC_MAX_CORRECTION: f64 = 0.01;

/// Decoded audio on a deck: planar stereo. It may still be filling up while it plays.
pub struct Track {
    pub rate: f64,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
    /// Frames the track will have once loaded.
    pub total: usize,
}

impl Track {
    pub fn with_capacity(frames: usize, rate: f64) -> Self {
        Self {
            rate,
            left: Vec::with_capacity(frames),
            right: Vec::with_capacity(frames),
            total: frames,
        }
    }

    pub fn from_buffers(rate: f64, left: Vec<f32>, right: Vec<f32>) -> Self {
        let total = left.len().min(right.len());
        Self {
            rate,
            left,
            right,
            total,
        }
    }

    /// Appends audio, never beyond `total` (so it never reallocates).
    pub fn push(&mut self, left: &[f32], right: &[f32]) {
        let n = left
            .len()
            .min(right.len())
            .min(self.total - self.left.len());
        self.left.extend_from_slice(&left[..n]);
        self.right.extend_from_slice(&right[..n]);
    }
}

/// What a synced deck follows: the master deck's tempo and where it is in its beat.
#[derive(Clone, Copy, Debug)]
pub struct MasterClock {
    /// Beats per minute as heard (0 when there is no master).
    pub bpm: f64,
    /// Where the master is within its bar, in beats: 0 to 4 (its grid's anchor is a
    /// downbeat).
    pub phase: f64,
    pub playing: bool,
}

impl MasterClock {
    pub const NONE: Self = Self {
        bpm: 0.0,
        phase: 0.0,
        playing: false,
    };
}

pub struct FrameOut {
    /// After the fader: what goes to the master.
    pub main: (f32, f32),
    /// Before the fader: what the headphone cue hears.
    pub pre_fader: (f32, f32),
}

pub struct Deck {
    pub track: Option<Track>,
    generation: u32,
    out_rate: f64,
    /// Where the deck is, in frames of the track.
    pos: f64,
    playing: bool,
    tempo: f64,
    bend: f64,
    reverse: bool,
    scratching: bool,
    scratch_target: f64,
    scratch_speed: f64,
    loop_in_s: f64,
    loop_out_s: f64,
    loop_on: bool,
    slip: bool,
    /// Where the track would be without the loop, scratch or reverse (slip mode).
    slip_pos: f64,
    slipping: bool,
    beat_s: f64,
    anchor_s: f64,
    sync: bool,
    /// Sync lines up bars, not just beats.
    sync_bars: bool,
    pub master: bool,
    /// A one-off jump into phase with the master is due: within this many beats
    /// (4 = line up bars, 1 = line up beats), or 0 for none.
    align: f64,
    tempo_eff: f64,
    phase_err: f64,
    /// Track frames per output frame this block.
    step: f64,
    /// The step kept while fading out after a stop.
    coast_step: f64,
    slip_step: f64,
    play_gain: f32,
    play_fade_step: f32,
    xf_pos: f64,
    xf_left: u32,
    xf_len: u32,
    trim: Smoothed,
    eq: [Smoothed; 3],
    volume: Smoothed,
    /// The channel's Sound Color FX (its COLOR knob is [`FILTER`]).
    pub color: ColorFx,
    iso: [Isolator; 2],
    pub cue: bool,
    pub peak: [f32; 2],
    scratch_alpha: f64,
    /// Master tempo: the pitch stays put when the tempo changes.
    keylock: bool,
    /// Key shift in semitones.
    key_shift: f64,
    stretcher: Stretcher,
    /// Whether the stretcher makes the sound now, and the track frames per output
    /// frame it reads grains at.
    stretching: bool,
    read_step: f64,
    /// Frames left of the fade from stretched to plain playback.
    unstretch_fade: u32,
}

impl Deck {
    pub fn new(out_rate: f64) -> Self {
        let smoothed = |v| Smoothed::new(v, out_rate, 0.008);
        Self {
            track: None,
            generation: 0,
            out_rate,
            pos: 0.0,
            playing: false,
            tempo: 1.0,
            bend: 0.0,
            reverse: false,
            scratching: false,
            scratch_target: 0.0,
            scratch_speed: 0.0,
            loop_in_s: 0.0,
            loop_out_s: 0.0,
            loop_on: false,
            slip: false,
            slip_pos: 0.0,
            slipping: false,
            beat_s: 0.0,
            anchor_s: 0.0,
            sync: false,
            sync_bars: true,
            master: false,
            align: 0.0,
            tempo_eff: 1.0,
            phase_err: 0.0,
            step: 0.0,
            coast_step: 0.0,
            slip_step: 0.0,
            play_gain: 0.0,
            play_fade_step: (1.0 / (PLAY_FADE_S * out_rate)) as f32,
            xf_pos: 0.0,
            xf_left: 0,
            xf_len: ((JUMP_FADE_S * out_rate) as u32).max(1),
            trim: smoothed(1.0),
            eq: [smoothed(1.0), smoothed(1.0), smoothed(1.0)],
            volume: smoothed(1.0),
            color: ColorFx::new(out_rate),
            iso: [Isolator::new(out_rate), Isolator::new(out_rate)],
            cue: false,
            peak: [0.0; 2],
            scratch_alpha: 0.1,
            keylock: false,
            key_shift: 0.0,
            stretcher: Stretcher::new(out_rate),
            stretching: false,
            read_step: 1.0,
            unstretch_fade: 0,
        }
    }

    fn rate(&self) -> f64 {
        self.track.as_ref().map_or(self.out_rate, |t| t.rate)
    }

    pub fn has_grid(&self) -> bool {
        self.track.is_some() && self.beat_s > 0.0
    }

    pub fn load(&mut self, track: Track) {
        self.track = Some(track);
        self.generation += 1;
        self.reset_transport();
    }

    pub fn unload(&mut self) {
        self.track = None;
        self.generation += 1;
        self.reset_transport();
    }

    fn reset_transport(&mut self) {
        self.pos = 0.0;
        self.playing = false;
        self.reverse = false;
        self.scratching = false;
        self.loop_on = false;
        self.slipping = false;
        self.slip_pos = 0.0;
        self.beat_s = 0.0;
        self.anchor_s = 0.0;
        self.xf_left = 0;
        self.play_gain = 0.0;
        self.step = 0.0;
        self.coast_step = 0.0;
    }

    pub fn set(&mut self, param: u32, value: f64) {
        let on = value > 0.5;
        match param {
            PLAY => {
                let play = on && self.track.is_some();
                if play && !self.playing && self.sync {
                    self.align = self.bar_unit();
                }
                self.playing = play;
            }
            SEEK => {
                let to = value.max(0.0) * self.rate();
                self.jump_to(to);
                self.slip_pos = to;
                // A synced deck that jumps lands back on the master's beat at once
                // (whole-beat jumps keep their place in the bar).
                if self.sync && self.align == 0.0 {
                    self.align = 1.0;
                }
            }
            TEMPO => self.tempo = value.clamp(0.0, 4.0),
            BEND => self.bend = value.clamp(-1.0, 1.0),
            SCRATCH => {
                if on && !self.scratching {
                    // Start from the speed the deck is moving at, so touching is smooth.
                    self.scratch_speed = self.step / (self.rate() / self.out_rate);
                    self.scratch_target = 0.0;
                }
                self.scratching = on && self.track.is_some();
            }
            SCRATCH_SPEED => self.scratch_target = value.clamp(-16.0, 16.0),
            REVERSE => self.reverse = on,
            LOOP_IN => self.loop_in_s = value.max(0.0),
            LOOP_OUT => self.loop_out_s = value.max(0.0),
            LOOP_ON => {
                self.loop_on = on && self.loop_out_s > self.loop_in_s;
                let (a, b) = (self.loop_in_s * self.rate(), self.loop_out_s * self.rate());
                if self.loop_on && self.pos >= b {
                    self.jump_to(a);
                }
            }
            SLIP => {
                if on && !self.slip {
                    self.slip_pos = self.pos;
                }
                self.slip = on;
            }
            BEAT => self.beat_s = value.max(0.0),
            ANCHOR => self.anchor_s = value,
            SYNC => {
                if on && !self.sync {
                    self.align = self.bar_unit();
                }
                self.sync = on;
            }
            MASTER => self.master = on,
            SYNC_BARS => self.sync_bars = on,
            TRIM => self.trim.target = value as f32,
            EQ_LOW => self.eq[0].target = value as f32,
            EQ_MID => self.eq[1].target = value as f32,
            EQ_HIGH => self.eq[2].target = value as f32,
            FILTER => self.color.set_knob(value as f32),
            VOLUME => self.volume.target = value as f32,
            CUE => self.cue = on,
            ALIGN => self.align = self.bar_unit(),
            KEYLOCK => self.keylock = on,
            KEY_SHIFT => self.key_shift = value.clamp(-12.0, 12.0),
            _ => {}
        }
    }

    fn bar_unit(&self) -> f64 {
        if self.sync_bars {
            4.0
        } else {
            1.0
        }
    }

    /// Moves to `to` (track frames), crossfading if the deck is sounding.
    fn jump_to(&mut self, to: f64) {
        if self.stretching {
            // The stretcher's grains crossfade the jump themselves.
            self.stretcher.force_grain();
        } else if self.play_gain > 0.0 {
            self.xf_pos = self.pos;
            self.xf_left = self.xf_len;
        }
        self.pos = to;
    }

    /// Where the deck is within its bar, in beats: 0 to 4.
    fn bar_phase(&self) -> f64 {
        ((self.pos / self.rate() - self.anchor_s) / self.beat_s).rem_euclid(4.0)
    }

    pub fn clock(&self) -> MasterClock {
        let speed = if self.playing {
            self.tempo + self.bend
        } else {
            self.tempo
        };
        MasterClock {
            bpm: 60.0 / self.beat_s * speed,
            phase: self.bar_phase(),
            playing: self.playing && !self.scratching,
        }
    }

    /// Works out this block's speed: tempo, sync, bend, scratch.
    pub fn begin_block(&mut self, clock: &MasterClock, block_s: f64) {
        self.color.begin_block(clock.bpm);
        let Some(rate) = self.track.as_ref().map(|t| t.rate) else {
            self.step = 0.0;
            return;
        };
        let ratio = rate / self.out_rate;

        let slipping = self.slip && (self.loop_on || self.scratching || self.reverse);
        if self.slipping && !slipping {
            self.jump_to(self.slip_pos);
        }
        self.slipping = slipping;

        self.tempo_eff = self.tempo;
        self.phase_err = 0.0;
        let mut correction = 0.0;
        if self.sync && !self.master && clock.bpm > 0.0 && self.beat_s > 0.0 {
            let ratio_to_master = clock.bpm * self.beat_s / 60.0;
            // Half or double tempo when that is closer to normal speed (87 against 174).
            let tempo = [
                ratio_to_master * 0.5,
                ratio_to_master,
                ratio_to_master * 2.0,
            ]
            .into_iter()
            .min_by(|a, b| (a - 1.0).abs().total_cmp(&(b - 1.0).abs()))
            .unwrap_or(ratio_to_master);
            self.tempo_eff = tempo;
            if tempo == ratio_to_master {
                // How far behind the master this deck is, in beats, within `unit`
                // beats: a bar when sync engages (downbeats together), a beat after
                // that (so a deliberate beat jump stays where it was put).
                let gap = clock.phase - self.bar_phase();
                let behind = |unit: f64| (gap + unit / 2.0).rem_euclid(unit) - unit / 2.0;
                let e = behind(1.0);
                self.phase_err = e;
                if self.align > 0.0 && clock.playing {
                    let jump = behind(self.align);
                    self.jump_to(self.pos + jump * self.beat_s * rate);
                    self.phase_err = 0.0;
                } else if self.playing && clock.playing && !self.scratching {
                    correction = (e * self.beat_s / SYNC_CORRECT_S)
                        .clamp(-SYNC_MAX_CORRECTION, SYNC_MAX_CORRECTION);
                }
            }
        }
        self.align = 0.0;

        self.scratch_alpha = 1.0 - (-block_s / SCRATCH_SMOOTH_S).exp();
        let speed = if self.scratching {
            self.scratch_speed += (self.scratch_target - self.scratch_speed) * self.scratch_alpha;
            self.scratch_speed
        } else if self.playing {
            let s = self.tempo_eff + self.bend + correction;
            if self.reverse {
                -s
            } else {
                s
            }
        } else {
            0.0
        };
        self.step = speed * ratio;
        if self.playing || self.scratching {
            self.coast_step = self.step;
        }

        // Keylock and key shift: stretched playback whenever the deck plays forward
        // on its own (scratching and reverse sound like a record, as they should).
        let shift = 2f64.powf(self.key_shift / 12.0);
        let stretch = (self.keylock || self.key_shift != 0.0) && !self.scratching && speed > 0.0;
        let pitch = if self.keylock { shift } else { speed * shift };
        self.read_step = ratio * pitch;
        if stretch && !self.stretching {
            self.stretcher.reset(self.pos, self.read_step);
            self.xf_left = 0;
        } else if !stretch && self.stretching {
            self.unstretch_fade = self.xf_len;
        }
        self.stretching = stretch;
        self.slip_step = if self.playing {
            self.tempo_eff * ratio
        } else {
            0.0
        };
    }

    /// The next output frame, or `None` while the deck is silent.
    #[inline]
    pub fn next_frame(&mut self) -> Option<FrameOut> {
        let active = self.playing || self.scratching;
        if !active && self.play_gain == 0.0 {
            return None;
        }
        let step = if active { self.step } else { self.coast_step };
        let (mut l, mut r, total, rate) = {
            let t = self.track.as_ref()?;
            let (mut l, mut r);
            if self.stretching {
                (l, r) = self
                    .stretcher
                    .next(&t.left, &t.right, self.pos, self.read_step);
            } else {
                l = sample_at(&t.left, self.pos);
                r = sample_at(&t.right, self.pos);
                if self.xf_left > 0 {
                    let w = self.xf_left as f32 / self.xf_len as f32;
                    l = l * (1.0 - w) + sample_at(&t.left, self.xf_pos) * w;
                    r = r * (1.0 - w) + sample_at(&t.right, self.xf_pos) * w;
                }
                if self.unstretch_fade > 0 {
                    // Back to plain playback: fade out of the stretched sound.
                    let w = self.unstretch_fade as f32 / self.xf_len as f32;
                    let (sl, sr) = self
                        .stretcher
                        .next(&t.left, &t.right, self.pos, self.read_step);
                    l = l * (1.0 - w) + sl * w;
                    r = r * (1.0 - w) + sr * w;
                    self.unstretch_fade -= 1;
                }
            }
            (l, r, t.total as f64, t.rate)
        };
        if self.xf_left > 0 {
            self.xf_pos += step;
            self.xf_left -= 1;
        }
        if active {
            self.play_gain = (self.play_gain + self.play_fade_step).min(1.0);
        } else {
            self.play_gain = (self.play_gain - self.play_fade_step).max(0.0);
        }

        self.pos += step;
        if self.slipping {
            self.slip_pos += self.slip_step;
        } else {
            self.slip_pos = self.pos;
        }
        if self.loop_on {
            let (a, b) = (self.loop_in_s * rate, self.loop_out_s * rate);
            if step > 0.0 && self.pos >= b {
                self.jump_to(self.pos - (b - a));
            } else if step < 0.0 && self.pos < a {
                self.jump_to(self.pos + (b - a));
            }
        }
        if self.pos >= total {
            self.pos = total;
            if step > 0.0 {
                self.playing = false;
            }
        } else if self.pos < 0.0 {
            self.pos = 0.0;
            if step < 0.0 && !self.scratching {
                self.playing = false;
            }
        }

        let g = self.play_gain;
        let eq = [self.eq[0].tick(), self.eq[1].tick(), self.eq[2].tick()];
        let trim = self.trim.tick();
        l = self.iso[0].process(l * g, eq) * trim;
        r = self.iso[1].process(r * g, eq) * trim;
        (l, r) = self.color.process(l, r);
        self.peak[0] = self.peak[0].max(l.abs());
        self.peak[1] = self.peak[1].max(r.abs());
        let v = self.volume.tick();
        Some(FrameOut {
            main: (l * v, r * v),
            pre_fader: (l, r),
        })
    }

    pub fn write_state(&self, s: &mut [f64]) {
        let rate = self.rate();
        let (loaded, total) = self
            .track
            .as_ref()
            .map_or((0.0, 0.0), |t| (t.left.len() as f64, t.total as f64));
        let active = self.playing || self.scratching;
        s[S_POS] = self.pos / rate;
        s[S_PLAYING] = self.playing as u8 as f64;
        s[S_SPEED] = if active {
            self.step / (rate / self.out_rate)
        } else {
            0.0
        };
        s[S_LOADED] = loaded / rate;
        s[S_DURATION] = total / rate;
        s[S_LOOP_ON] = self.loop_on as u8 as f64;
        s[S_LOOP_IN] = self.loop_in_s;
        s[S_LOOP_OUT] = self.loop_out_s;
        s[S_PEAK_L] = self.peak[0] as f64;
        s[S_PEAK_R] = self.peak[1] as f64;
        s[S_SLIP_POS] = self.slip_pos / rate;
        s[S_SLIPPING] = self.slipping as u8 as f64;
        s[S_TEMPO] = self.tempo_eff;
        s[S_GENERATION] = self.generation as f64;
        s[S_PHASE] = self.phase_err;
        s[S_PITCH] = if self.stretching {
            self.read_step / (rate / self.out_rate)
        } else {
            s[S_SPEED].abs()
        };
    }
}
