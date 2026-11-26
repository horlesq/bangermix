//! A DJ mixer's one-knob filter (from double-drop `dd-engine`, commit 9d3a720).

use std::f64::consts::PI;

/// The high-pass sweeps up from the first to the second frequency.
const HIGH_PASS_HZ: (f64, f64) = (20.0, 8000.0);
/// The low-pass sweeps down from the first to the second.
const LOW_PASS_HZ: (f64, f64) = (20_000.0, 100.0);
/// A little resonance, as on DJ mixer filters.
const FILTER_Q: f64 = 0.9;
/// Knob positions this close to the centre are off.
const DEAD_ZONE: f32 = 0.02;

/// 0 is off, positive is a high-pass, negative a low-pass. A topology-preserving
/// state-variable filter (after Simper), which stays stable and click-free while its
/// cutoff moves every sample. Stereo: one state per channel.
#[derive(Clone, Debug)]
pub struct DjFilter {
    sample_rate: f64,
    position: f32,
    k: f32,
    a: [f32; 3],
    ic1: [f32; 2],
    ic2: [f32; 2],
}

impl DjFilter {
    pub fn new(sample_rate: f64) -> Self {
        Self {
            sample_rate,
            position: 0.0,
            k: (1.0 / FILTER_Q) as f32,
            a: [1.0, 0.0, 0.0],
            ic1: [0.0; 2],
            ic2: [0.0; 2],
        }
    }

    /// Resonance: Q, 0.5 (none) to about 4 (sharp). 0.9 by default.
    pub fn set_resonance(&mut self, q: f32) {
        let k = 1.0 / q.clamp(0.5, 6.0);
        if k != self.k {
            self.k = k;
            self.coefficients();
        }
    }

    /// Sets the knob, -1 (low-pass closed) to 1 (high-pass closed).
    #[inline]
    pub fn set(&mut self, position: f32) {
        let mut position = position.clamp(-1.0, 1.0);
        if position.abs() < DEAD_ZONE {
            position = 0.0;
        }
        if position == self.position {
            return;
        }
        if self.position == 0.0 || position.signum() != self.position.signum() {
            // Off until now, or switching kind: start from silence rather than stale state.
            self.ic1 = [0.0; 2];
            self.ic2 = [0.0; 2];
        }
        self.position = position;
        self.coefficients();
    }

    fn coefficients(&mut self) {
        let position = self.position;
        if position == 0.0 {
            return;
        }
        let ((from, to), amount) = if position > 0.0 {
            (HIGH_PASS_HZ, position as f64)
        } else {
            (LOW_PASS_HZ, -position as f64)
        };
        let hz = (from * (to / from).powf(amount)).min(0.45 * self.sample_rate);
        let g = (PI * hz / self.sample_rate).tan() as f32;
        let a1 = 1.0 / (1.0 + g * (g + self.k));
        self.a = [a1, g * a1, g * g * a1];
    }

    #[inline]
    pub fn process(&mut self, channel: usize, x: f32) -> f32 {
        if self.position == 0.0 {
            return x;
        }
        let [a1, a2, a3] = self.a;
        let (ic1, ic2) = (&mut self.ic1[channel], &mut self.ic2[channel]);
        let v3 = x - *ic2;
        let v1 = a1 * *ic1 + a2 * v3;
        let v2 = *ic2 + a2 * *ic1 + a3 * v3;
        *ic1 = 2.0 * v1 - *ic1;
        *ic2 = 2.0 * v2 - *ic2;
        if self.position > 0.0 {
            x - self.k * v1 - v2
        } else {
            v2
        }
    }
}
