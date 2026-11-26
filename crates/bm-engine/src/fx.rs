//! Beat FX: one effect unit, synced to the master tempo, on one channel or the master,
//! with the effects of a Pioneer DJM-900NXS2.
//!
//! The echoes and the reverb are sends: switching them off stops feeding them and the
//! tail rings out (an "echo out"). The others replace the sound while on and fade back.
//! LEVEL/DEPTH is `wet`; each effect has one more knob, `param`.

use crate::param::*;
use bm_dsp::{Smoothed, Svf};
use std::f64::consts::{PI, TAU};

pub const OFF: u32 = 0;
/// Repeats that ring on, thinning out (param: feedback).
pub const ECHO: u32 = 1;
/// A reverb send (param: size).
pub const REVERB: u32 = 2;
/// A jet sweep over `beats` × 8 (param: feedback).
pub const FLANGER: u32 = 3;
/// Repeats the `beats` from when it was switched on; a new length captures afresh.
pub const ROLL: u32 = 4;
/// One repeat, `beats` later (param: a little feedback).
pub const DELAY: u32 = 5;
/// Echo bouncing between left and right (param: feedback).
pub const PING_PONG: u32 = 6;
/// An echo blurred by diffusion; changing the length bends its pitch (param: feedback).
pub const SPIRAL: u32 = 7;
/// Cuts the sound in and out every `beats` (param: how long it stays open).
pub const TRANS: u32 = 8;
/// A low-pass that sweeps over `beats` × 4 (param: resonance).
pub const FILTER: u32 = 9;
/// A phaser sweeping over `beats` × 8 (param: feedback).
pub const PHASER: u32 = 10;
/// Shifts the pitch, without beats (param: -12 to +12 semitones).
pub const PITCH: u32 = 11;
/// Repeats the `beats` from when it was switched on; a new length keeps its place.
pub const SLIP_ROLL: u32 = 12;
/// Slows the sound to a stop over `beats`, like a turntable switched off.
pub const VINYL_BRAKE: u32 = 13;
/// Holds the `beats` from when it was switched on and lets them ring, new sound fading
/// in under them (param: how much new sound).
pub const HELIX: u32 = 14;
/// The FX target that means the master output.
pub const TARGET_MASTER: u32 = 4;

/// Longest echo or roll.
const MAX_DELAY_S: f64 = 8.0;
/// Tempo the FX follow when there is no master deck.
const DEFAULT_BPM: f64 = 120.0;
/// Grain of the pitch shifter.
const GRAIN_S: f64 = 0.06;

pub struct BeatFx {
    sr: f64,
    kind: u32,
    target: u32,
    beats: f64,
    wet: f32,
    on: bool,
    param: f32,
    bpm: f64,
    /// Where the master is in its bar (beats), when it plays.
    bar_phase: Option<f64>,
    send: Smoothed,
    mix: Smoothed,
    buf: [Vec<f32>; 2],
    w: usize,
    delay: f64,
    tone: [Tone; 2],
    reverb: [Reverb; 2],
    diffuse: [[Diffuser; 2]; 2],
    svf: [Svf; 2],
    phaser: [[f32; 4]; 2],
    phaser_fb: [f32; 2],
    lfo: f64,
    roll_start: usize,
    roll_len: usize,
    roll_pos: usize,
    roll_beats: f64,
    brake_pos: f64,
    brake_speed: f64,
    grain: f64,
    held: usize,
}

impl BeatFx {
    pub fn new(sr: f64) -> Self {
        let len = (MAX_DELAY_S * sr) as usize + 4;
        let scale = sr / 44_100.0;
        let ap = |n: f64| Diffuser::new((n * scale) as usize);
        Self {
            sr,
            kind: OFF,
            target: TARGET_MASTER,
            beats: 0.75,
            wet: 0.6,
            on: false,
            param: 0.5,
            bpm: DEFAULT_BPM,
            bar_phase: None,
            send: Smoothed::new(0.0, sr, 0.005),
            mix: Smoothed::new(0.0, sr, 0.01),
            buf: [vec![0.0; len], vec![0.0; len]],
            w: 0,
            delay: sr * 0.5,
            tone: [Tone::new(sr), Tone::new(sr)],
            reverb: [Reverb::new(sr, 0), Reverb::new(sr, 23)],
            diffuse: [[ap(225.0), ap(341.0)], [ap(241.0), ap(367.0)]],
            svf: [Svf::new(), Svf::new()],
            phaser: [[0.0; 4]; 2],
            phaser_fb: [0.0; 2],
            lfo: 0.0,
            roll_start: 0,
            roll_len: 1,
            roll_pos: 0,
            roll_beats: 0.0,
            brake_pos: 0.0,
            brake_speed: 1.0,
            grain: 0.0,
            held: 0,
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
                if on && !self.on {
                    self.engage();
                }
                self.on = on;
            }
            _ => {}
        }
    }

    /// Switched on: rolls and holds start capturing here, the brake at full speed, the
    /// sweeps from the start of the bar.
    fn engage(&mut self) {
        self.roll_start = self.w;
        self.roll_pos = 0;
        self.roll_beats = self.beats;
        self.brake_pos = self.w as f64;
        self.brake_speed = 1.0;
        self.held = 0;
        if let Some(phase) = self.bar_phase {
            self.lfo = (phase / (4.0 * self.beats.max(0.25))).fract();
        }
    }

    fn clear(&mut self) {
        for b in &mut self.buf {
            b.fill(0.0);
        }
        for r in &mut self.reverb {
            r.clear();
        }
        for d in self.diffuse.iter_mut().flatten() {
            d.buf.fill(0.0);
        }
        for f in &mut self.svf {
            f.reset();
        }
        self.phaser = [[0.0; 4]; 2];
        self.phaser_fb = [0.0; 2];
    }

    fn beat_frames(&self) -> f64 {
        60.0 / self.bpm * self.sr
    }

    /// Before each block: the master's tempo, and its place in the bar when it plays.
    pub fn begin_block(&mut self, master_bpm: f64, bar_phase: Option<f64>) {
        self.bpm = if master_bpm > 1.0 {
            master_bpm
        } else {
            DEFAULT_BPM
        };
        self.bar_phase = bar_phase;
        let on = if self.on { 1.0 } else { 0.0 };
        self.send.target = on;
        self.mix.target = on;
        let max = (self.buf[0].len() - 4) as f64;
        self.roll_len = (self.beats * self.beat_frames()).clamp(64.0, max) as usize;
        if self.kind == ROLL && self.on && self.beats != self.roll_beats {
            // A new length captures afresh, from now.
            self.roll_beats = self.beats;
            self.roll_start = self.w;
            self.roll_pos = 0;
        }
        if self.kind == FILTER {
            // Swept per block: from 300 Hz to 12 kHz and back.
            let x = 0.5 - 0.5 * (TAU * self.lfo).cos();
            let hz = 300.0 * (12_000.0 / 300.0_f64).powf(x);
            let q = 0.7 + 4.0 * self.param as f64;
            for f in &mut self.svf {
                f.set(self.sr, hz, q);
            }
        }
    }

    /// A delay line's next value, gliding to `target` frames (no clicks; a slower glide
    /// bends the pitch, as SPIRAL does).
    #[inline]
    fn glide(&mut self, target: f64, rate: f64) -> f64 {
        let len = self.buf[0].len();
        let target = target.clamp(16.0, (len - 4) as f64);
        self.delay += (target - self.delay) * rate;
        self.delay
    }

    #[inline]
    fn advance_lfo(&mut self, cycle_beats: f64) {
        self.lfo = (self.lfo + 1.0 / (cycle_beats.max(0.25) * self.beat_frames())).fract();
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let send = self.send.tick();
        let mix = self.mix.tick();
        let len = self.buf[0].len();
        let wet = self.wet;
        let beats = self.beats;
        let mut advance = true;
        let out = match self.kind {
            ECHO | DELAY | SPIRAL => {
                let d = self.glide(
                    beats * self.beat_frames(),
                    if self.kind == SPIRAL { 0.00005 } else { 0.0005 },
                );
                let feedback = match self.kind {
                    ECHO => 0.3 + 0.65 * self.param,
                    DELAY => 0.25 * self.param,
                    _ => 0.55 + 0.4 * self.param,
                };
                let mut out = [l, r];
                for (ch, x) in [l, r].into_iter().enumerate() {
                    let delayed = read(&self.buf[ch], self.w, d);
                    let mut back = self.tone[ch].process(delayed);
                    if self.kind == SPIRAL {
                        let once = self.diffuse[ch][0].process(back);
                        back = self.diffuse[ch][1].process(once);
                    }
                    self.buf[ch][self.w] = x * send + back * feedback;
                    out[ch] = x + delayed * wet;
                }
                out
            }
            PING_PONG => {
                let d = self.glide(beats * self.beat_frames(), 0.0005);
                let feedback = 0.3 + 0.6 * self.param;
                let dl = read(&self.buf[0], self.w, d);
                let dr = read(&self.buf[1], self.w, d);
                // Left feeds right and right feeds left: each repeat swaps sides.
                self.buf[0][self.w] = 0.5 * (l + r) * send + self.tone[1].process(dr) * feedback;
                self.buf[1][self.w] = self.tone[0].process(dl) * feedback;
                [l + dl * wet, r + dr * wet]
            }
            REVERB => {
                let size = 0.7 + 0.28 * self.param;
                let wl = self.reverb[0].process(l * send, size);
                let wr = self.reverb[1].process(r * send, size);
                [l + wl * wet, r + wr * wet]
            }
            FLANGER => {
                self.advance_lfo(beats * 8.0);
                let ms = 1.0 + 4.0 * (0.5 - 0.5 * (TAU * self.lfo).cos());
                let d = ms * 0.001 * self.sr;
                let feedback = 0.7 * self.param;
                let mut out = [l, r];
                for (ch, x) in [l, r].into_iter().enumerate() {
                    let delayed = read(&self.buf[ch], self.w, d);
                    self.buf[ch][self.w] = x + delayed * feedback;
                    let m = mix * wet;
                    out[ch] = x * (1.0 - 0.5 * m) + delayed * 0.5 * m;
                }
                out
            }
            PHASER => {
                self.advance_lfo(beats * 8.0);
                let x = 0.5 - 0.5 * (TAU * self.lfo).cos();
                let hz = 200.0 * (3000.0 / 200.0_f64).powf(x);
                let t = (PI * hz / self.sr).tan();
                let a = ((t - 1.0) / (t + 1.0)) as f32;
                let feedback = 0.8 * self.param;
                let mut out = [l, r];
                for (ch, x) in [l, r].into_iter().enumerate() {
                    let mut y = x + self.phaser_fb[ch] * feedback;
                    for z in &mut self.phaser[ch] {
                        // First-order all-pass: y = a·x + z; z = x − a·y.
                        let o = a * y + *z;
                        *z = y - a * o;
                        y = o;
                    }
                    self.phaser_fb[ch] = y;
                    let m = mix * wet;
                    out[ch] = x * (1.0 - 0.5 * m) + y * 0.5 * m;
                }
                out
            }
            TRANS => {
                self.advance_lfo(beats);
                let duty = 0.15 + 0.7 * self.param as f64;
                // A short ramp at each edge, so the cuts don't click.
                let edge = (2.0 * 0.003 * self.sr / (beats.max(1.0 / 32.0) * self.beat_frames()))
                    .min(0.05);
                let p = self.lfo;
                let open = if p < duty {
                    (p / edge).min(1.0).min((duty - p) / edge)
                } else {
                    0.0
                } as f32;
                let g = 1.0 - mix * wet * (1.0 - open);
                [l * g, r * g]
            }
            FILTER => {
                self.advance_lfo(beats * 4.0);
                let fl = self.svf[0].process(l).low;
                let fr = self.svf[1].process(r).low;
                let m = mix * wet;
                [l + (fl - l) * m, r + (fr - r) * m]
            }
            PITCH => {
                // Two read heads half a grain apart, each faded in and out, drifting at
                // the pitch ratio's rate.
                let ratio = 2f64.powf((self.param as f64 - 0.5) * 24.0 / 12.0);
                let g = GRAIN_S * self.sr;
                self.grain = (self.grain + (1.0 - ratio)).rem_euclid(g);
                let mut out = [l, r];
                for ch in 0..2 {
                    self.buf[ch][self.w] = [l, r][ch];
                    let mut y = 0.0;
                    for k in 0..2 {
                        let d = (self.grain + k as f64 * g / 2.0).rem_euclid(g) + 8.0;
                        let win = (PI * (d - 8.0) / g).sin() as f32;
                        y += read(&self.buf[ch], self.w, d) * win * win;
                    }
                    let m = mix * wet;
                    out[ch] = [l, r][ch] * (1.0 - m) + y * m;
                }
                out
            }
            ROLL | SLIP_ROLL => {
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
                advance = !self.on || self.roll_pos <= self.roll_len;
                let m = mix * wet.max(0.5);
                [
                    l * (1.0 - m) + self.buf[0][at] * m,
                    r * (1.0 - m) + self.buf[1][at] * m,
                ]
            }
            VINYL_BRAKE => {
                self.buf[0][self.w] = l;
                self.buf[1][self.w] = r;
                if self.on {
                    // Speed falls from 1 to 0 over `beats`; reading lags further behind.
                    self.brake_speed =
                        (self.brake_speed - 1.0 / (beats * self.beat_frames())).max(0.0);
                    self.brake_pos += self.brake_speed;
                }
                let behind = (self.w as f64 - self.brake_pos).rem_euclid(len as f64);
                // The level falls away in the last moments, as a platter's does.
                let level = (self.brake_speed * 6.0).min(1.0) as f32;
                let y = if self.on {
                    [
                        read(&self.buf[0], self.w, behind) * level,
                        read(&self.buf[1], self.w, behind) * level,
                    ]
                } else {
                    [0.0, 0.0]
                };
                let m = mix * wet.max(0.5);
                [l * (1.0 - m) + y[0] * m, r * (1.0 - m) + y[1] * m]
            }
            HELIX => {
                // An echo whose repeats never fade: once the held beats are in, new sound
                // only trickles in (`param`) under them.
                let d = self.roll_len as f64;
                let holding = self.on && self.held >= self.roll_len;
                if self.on {
                    self.held += 1;
                }
                let input = if holding { 0.15 * self.param } else { 1.0 };
                let mut out = [l, r];
                for (ch, x) in [l, r].into_iter().enumerate() {
                    let delayed = read(&self.buf[ch], self.w, d);
                    let feedback = if self.on { 0.98 } else { 0.0 };
                    self.buf[ch][self.w] = x * input * send + delayed * feedback;
                    let m = mix * wet;
                    out[ch] = x * (1.0 - 0.7 * m) + delayed * m;
                }
                out
            }
            _ => [l, r],
        };
        if advance {
            self.w = (self.w + 1) % len;
        }
        (out[0], out[1])
    }
}

/// A Schroeder all-pass (gain 0.6): smears a sound in time without colouring its level,
/// so it can sit in a feedback loop.
struct Diffuser {
    buf: Vec<f32>,
    i: usize,
}

impl Diffuser {
    const G: f32 = 0.6;

    fn new(len: usize) -> Self {
        Self {
            buf: vec![0.0; len.max(1)],
            i: 0,
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let delayed = self.buf[self.i];
        let y = delayed - Self::G * x;
        self.buf[self.i] = x + Self::G * y;
        self.i = (self.i + 1) % self.buf.len();
        y
    }
}

/// The ring buffer `d` frames before the write position, linearly interpolated.
#[inline]
pub(crate) fn read(buf: &[f32], w: usize, d: f64) -> f32 {
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
pub(crate) struct Tone {
    hp_coef: f32,
    lp_coef: f32,
    hp_in: f32,
    hp_out: f32,
    lp_out: f32,
}

impl Tone {
    pub(crate) fn new(sr: f64) -> Self {
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
    pub(crate) fn process(&mut self, x: f32) -> f32 {
        self.hp_out = self.hp_coef * (self.hp_out + x - self.hp_in);
        self.hp_in = x;
        self.lp_out += (self.hp_out - self.lp_out) * self.lp_coef;
        self.lp_out
    }
}

/// A small Schroeder/Freeverb-style reverb: four damped combs into two all-passes.
pub(crate) struct Reverb {
    combs: [Comb; 4],
    allpasses: [Allpass; 2],
}

impl Reverb {
    /// `spread` offsets the delay lengths, so left and right differ.
    pub(crate) fn new(sr: f64, spread: usize) -> Self {
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

    pub(crate) fn clear(&mut self) {
        for c in &mut self.combs {
            c.buf.fill(0.0);
        }
        for a in &mut self.allpasses {
            a.buf.fill(0.0);
        }
    }

    #[inline]
    pub(crate) fn process(&mut self, x: f32, size: f32) -> f32 {
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
