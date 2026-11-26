//! A state-variable filter (Andrew Simper's trapezoidal form): low-pass, band-pass and
//! high-pass from one state, stable while its cutoff moves every sample, as swept
//! effects need.

use std::f64::consts::PI;

#[derive(Clone, Copy, Debug)]
pub struct SvfOut {
    pub low: f32,
    pub band: f32,
    pub high: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct Svf {
    k: f32,
    a1: f32,
    a2: f32,
    a3: f32,
    g: f32,
    ic1: f32,
    ic2: f32,
}

impl Default for Svf {
    fn default() -> Self {
        Self::new()
    }
}

impl Svf {
    pub fn new() -> Self {
        let mut f = Self {
            k: 1.0,
            a1: 0.0,
            a2: 0.0,
            a3: 0.0,
            g: 0.0,
            ic1: 0.0,
            ic2: 0.0,
        };
        f.set(44_100.0, 1000.0, 0.707);
        f
    }

    /// Cutoff (or centre) `hz` and resonance `q` (0.5 gentle … 10 sharp).
    #[inline]
    pub fn set(&mut self, sample_rate: f64, hz: f64, q: f64) {
        let hz = hz.clamp(10.0, 0.45 * sample_rate);
        self.g = (PI * hz / sample_rate).tan() as f32;
        self.k = (1.0 / q.max(0.1)) as f32;
        self.a1 = 1.0 / (1.0 + self.g * (self.g + self.k));
        self.a2 = self.g * self.a1;
        self.a3 = self.g * self.a2;
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> SvfOut {
        let v3 = x - self.ic2;
        let v1 = self.a1 * self.ic1 + self.a2 * v3;
        let v2 = self.ic2 + self.a2 * self.ic1 + self.a3 * v3;
        self.ic1 = 2.0 * v1 - self.ic1;
        self.ic2 = 2.0 * v2 - self.ic2;
        SvfOut {
            low: v2,
            band: v1,
            high: x - self.k * v1 - v2,
        }
    }

    pub fn reset(&mut self) {
        self.ic1 = 0.0;
        self.ic2 = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    fn level(sr: f64, hz: f64, set: impl Fn(&mut Svf), pick: impl Fn(SvfOut) -> f32) -> f32 {
        let mut f = Svf::new();
        set(&mut f);
        let n = (sr * 0.4) as usize;
        let mut peak = 0.0_f32;
        for i in 0..n {
            let y = pick(f.process((TAU * hz * i as f64 / sr).sin() as f32));
            if i > n / 2 {
                peak = peak.max(y.abs());
            }
        }
        peak
    }

    #[test]
    fn its_outputs_split_the_spectrum() {
        let sr = 48_000.0;
        let set = |f: &mut Svf| f.set(sr, 1000.0, 0.707);
        assert!(level(sr, 100.0, set, |o| o.low) > 0.95);
        assert!(level(sr, 10_000.0, set, |o| o.low) < 0.02);
        assert!(level(sr, 100.0, set, |o| o.high) < 0.02);
        assert!(level(sr, 10_000.0, set, |o| o.high) > 0.95);
        // Band-pass: loudest at the centre.
        let centre = level(sr, 1000.0, set, |o| o.band);
        assert!(centre > 4.0 * level(sr, 100.0, set, |o| o.band));
        assert!(centre > 4.0 * level(sr, 10_000.0, set, |o| o.band));
    }
}
