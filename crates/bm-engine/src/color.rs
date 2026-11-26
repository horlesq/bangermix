//! Sound Color FX, as on a Pioneer DJM-900NXS2: one effect type for the whole mixer, a
//! COLOR knob per channel (off in the centre, a different flavour either side) and one
//! PARAMETER knob. On each channel after the EQ, before the fader, so the headphone cue
//! hears it too.
//!
//! - FILTER: low-pass left, high-pass right; PARAMETER is the resonance.
//! - SPACE: reverb, its return low-passed left and high-passed right; PARAMETER, its size.
//! - DUB ECHO: a 3/4-beat echo whose repeats darken (left) or thin out (right);
//!   PARAMETER, the feedback.
//! - SWEEP: a gate that tightens the sound (left), a band-pass sweep (right);
//!   PARAMETER, how hard the gate or how narrow the band.
//! - NOISE: white noise mixed in through a filter that closes (left) or opens (right);
//!   PARAMETER, the filter's resonance (the noise's colour).
//! - CRUSH: bit and sample-rate reduction, high-passed as well to the right; PARAMETER,
//!   the amount.

use crate::fx::{read, Reverb};
use bm_dsp::{DjFilter, Smoothed, Svf};

pub const FILTER: u32 = 0;
pub const SPACE: u32 = 1;
pub const DUB_ECHO: u32 = 2;
pub const SWEEP: u32 = 3;
pub const NOISE: u32 = 4;
pub const CRUSH: u32 = 5;

/// Knob positions this close to the centre are off.
const DEAD_ZONE: f32 = 0.02;
const ECHO_MAX_S: f64 = 2.0;
const DEFAULT_BPM: f64 = 120.0;

/// `from` at 0, `to` at 1, exponentially between (for frequencies).
#[inline]
fn sweep(from: f64, to: f64, amount: f32) -> f64 {
    from * (to / from).powf(amount as f64)
}

pub struct ColorFx {
    sr: f64,
    kind: u32,
    param: f32,
    knob: f32,
    /// How far the knob is from the centre, 0..1, gliding.
    amount: Smoothed,
    /// Which side the knob was last turned to (a tail keeps its colour).
    side: f32,
    filter: DjFilter,
    reverb: [Reverb; 2],
    ret: [Svf; 2],
    echo: [Vec<f32>; 2],
    w: usize,
    delay: f64,
    bpm: f64,
    env_fast: f32,
    env_slow: f32,
    gate: f32,
    noise: u32,
    hold: [f32; 2],
    hold_left: f32,
    q: f32,
}

impl ColorFx {
    pub fn new(sr: f64) -> Self {
        let len = (ECHO_MAX_S * sr) as usize + 4;
        Self {
            sr,
            kind: FILTER,
            param: 0.5,
            knob: 0.0,
            amount: Smoothed::new(0.0, sr, 0.01),
            side: 1.0,
            filter: DjFilter::new(sr),
            reverb: [Reverb::new(sr, 0), Reverb::new(sr, 23)],
            ret: [Svf::new(), Svf::new()],
            echo: [vec![0.0; len], vec![0.0; len]],
            w: 0,
            delay: sr * 0.375,
            bpm: DEFAULT_BPM,
            env_fast: 0.0,
            env_slow: 0.0,
            gate: 1.0,
            noise: 0x9e37_79b9,
            hold: [0.0; 2],
            hold_left: 0.0,
            q: 1.0,
        }
    }

    pub fn set_kind(&mut self, kind: u32) {
        if kind == self.kind {
            return;
        }
        self.kind = kind;
        for r in &mut self.reverb {
            r.clear();
        }
        for b in &mut self.echo {
            b.fill(0.0);
        }
        for f in &mut self.ret {
            f.reset();
        }
        self.gate = 1.0;
    }

    pub fn set_param(&mut self, param: f32) {
        self.param = param.clamp(0.0, 1.0);
    }

    /// The channel's COLOR knob, -1 to 1.
    pub fn set_knob(&mut self, knob: f32) {
        self.knob = knob.clamp(-1.0, 1.0);
    }

    pub fn begin_block(&mut self, master_bpm: f64) {
        self.bpm = if master_bpm > 1.0 {
            master_bpm
        } else {
            DEFAULT_BPM
        };
        let k = self.knob;
        let a = if k.abs() < DEAD_ZONE {
            0.0
        } else {
            (k.abs() - DEAD_ZONE) / (1.0 - DEAD_ZONE)
        };
        self.amount.target = a;
        if a > 0.0 {
            self.side = k.signum();
        }
        let p = self.param;
        // The gliding amount, so a sweep follows the knob without stepping.
        let amt = self.amount.value;
        let left = self.side < 0.0;
        match self.kind {
            FILTER => {
                self.filter.set_resonance(0.9 * 4f32.powf(2.0 * p - 1.0));
                self.filter.set(k);
            }
            SPACE => {
                let hz = if left {
                    sweep(8000.0, 300.0, amt)
                } else {
                    sweep(150.0, 4000.0, amt)
                };
                for f in &mut self.ret {
                    f.set(self.sr, hz, 0.7);
                }
            }
            DUB_ECHO => {
                let hz = if left {
                    sweep(6000.0, 600.0, amt)
                } else {
                    sweep(200.0, 2500.0, amt)
                };
                for f in &mut self.ret {
                    f.set(self.sr, hz, 0.7);
                }
            }
            SWEEP => {
                self.q = 0.7 + 5.0 * p;
                let hz = sweep(200.0, 8000.0, amt);
                for f in &mut self.ret {
                    f.set(self.sr, hz, self.q as f64);
                }
            }
            NOISE => {
                let hz = if left {
                    sweep(18_000.0, 300.0, amt)
                } else {
                    sweep(30.0, 8000.0, amt)
                };
                for f in &mut self.ret {
                    f.set(self.sr, hz, 0.7 + 3.0 * p as f64);
                }
            }
            CRUSH => {
                let hz = sweep(100.0, 3000.0, amt);
                for f in &mut self.ret {
                    f.set(self.sr, hz, 0.7);
                }
            }
            _ => {}
        }
    }

    #[inline]
    fn white(&mut self) -> f32 {
        self.noise ^= self.noise << 13;
        self.noise ^= self.noise >> 17;
        self.noise ^= self.noise << 5;
        self.noise as f32 / u32::MAX as f32 * 2.0 - 1.0
    }

    #[inline]
    pub fn process(&mut self, l: f32, r: f32) -> (f32, f32) {
        let a = self.amount.tick();
        let left = self.side < 0.0;
        match self.kind {
            FILTER => (self.filter.process(0, l), self.filter.process(1, r)),
            SPACE => {
                let size = 0.7 + 0.28 * self.param;
                let wl = self.reverb[0].process(l * a, size);
                let wr = self.reverb[1].process(r * a, size);
                let rl = self.ret[0].process(wl);
                let rr = self.ret[1].process(wr);
                let (rl, rr) = if left {
                    (rl.low, rr.low)
                } else {
                    (rl.high, rr.high)
                };
                (l + 1.4 * rl, r + 1.4 * rr)
            }
            DUB_ECHO => {
                let len = self.echo[0].len();
                let target = (0.75 * 60.0 / self.bpm * self.sr).clamp(64.0, (len - 4) as f64);
                self.delay += (target - self.delay) * 0.0005;
                let feedback = 0.35 + 0.55 * self.param;
                let mut out = [l, r];
                for (ch, x) in [l, r].into_iter().enumerate() {
                    let d = read(&self.echo[ch], self.w, self.delay);
                    let f = self.ret[ch].process(d);
                    let shaped = if left { f.low } else { f.high };
                    self.echo[ch][self.w] = x * a + shaped * feedback;
                    out[ch] = x + d;
                }
                self.w = (self.w + 1) % len;
                (out[0], out[1])
            }
            _ if a < 1e-4 => (l, r),
            SWEEP if left => {
                // A gate: what falls below the recent level is cut, so the sound tightens.
                let x = l.abs().max(r.abs());
                let fast = if x > self.env_fast { 0.3 } else { 0.0015 };
                let slow = if x > self.env_slow { 0.01 } else { 0.0002 };
                self.env_fast += (x - self.env_fast) * fast;
                self.env_slow += (x - self.env_slow) * slow;
                let threshold = self.env_slow * a * (0.6 + 0.6 * self.param);
                let open = if self.env_fast > threshold {
                    1.0
                } else {
                    1.0 - a
                };
                self.gate += (open - self.gate) * if open > self.gate { 0.05 } else { 0.004 };
                (l * self.gate, r * self.gate)
            }
            SWEEP => {
                let mix = (a * 4.0).min(1.0);
                let bl = self.ret[0].process(l).band / self.q;
                let br = self.ret[1].process(r).band / self.q;
                (l + (bl - l) * mix, r + (br - r) * mix)
            }
            NOISE => {
                let (n0, n1) = (self.white(), self.white());
                let f0 = self.ret[0].process(n0);
                let f1 = self.ret[1].process(n1);
                let (nl, nr) = if left {
                    (f0.low, f1.low)
                } else {
                    (f0.high, f1.high)
                };
                let level = 0.25 * a;
                (l + nl * level, r + nr * level)
            }
            CRUSH => {
                // Fewer bits, and samples held for longer, the further the knob turns.
                let amount = a * (0.4 + 0.6 * self.param);
                let steps = 2f32.powf(15.0 - 12.0 * amount);
                self.hold_left -= 1.0;
                if self.hold_left <= 0.0 {
                    self.hold_left += 1.0 + 24.0 * amount * amount;
                    self.hold = [(l * steps).round() / steps, (r * steps).round() / steps];
                }
                let [cl, cr] = self.hold;
                if left {
                    (cl, cr)
                } else {
                    (self.ret[0].process(cl).high, self.ret[1].process(cr).high)
                }
            }
            _ => (l, r),
        }
    }
}
