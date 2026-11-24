//! A second-order IIR filter (from double-drop `dd-core::dsp`, commit 9d3a720).

use std::f64::consts::TAU;

/// A second-order IIR filter (RBJ cookbook), transposed direct form II.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

/// Q of a Butterworth second-order section.
pub const BUTTERWORTH_Q: f64 = std::f64::consts::FRAC_1_SQRT_2;

impl Biquad {
    pub fn lowpass(sample_rate: f64, hz: f64, q: f64) -> Self {
        let (cos, alpha) = Self::prewarp(sample_rate, hz, q);
        Self::normalised(
            (1.0 - cos) / 2.0,
            1.0 - cos,
            (1.0 - cos) / 2.0,
            1.0 + alpha,
            -2.0 * cos,
            1.0 - alpha,
        )
    }

    pub fn highpass(sample_rate: f64, hz: f64, q: f64) -> Self {
        let (cos, alpha) = Self::prewarp(sample_rate, hz, q);
        Self::normalised(
            (1.0 + cos) / 2.0,
            -(1.0 + cos),
            (1.0 + cos) / 2.0,
            1.0 + alpha,
            -2.0 * cos,
            1.0 - alpha,
        )
    }

    /// Passes every frequency at full level, shifting phase around `hz`. With
    /// [`BUTTERWORTH_Q`] it matches the phase of a Linkwitz-Riley crossover at `hz`,
    /// which is what keeps a three-band split flat when summed.
    pub fn allpass(sample_rate: f64, hz: f64, q: f64) -> Self {
        let (cos, alpha) = Self::prewarp(sample_rate, hz, q);
        Self::normalised(
            1.0 - alpha,
            -2.0 * cos,
            1.0 + alpha,
            1.0 + alpha,
            -2.0 * cos,
            1.0 - alpha,
        )
    }

    fn prewarp(sample_rate: f64, hz: f64, q: f64) -> (f64, f64) {
        let w0 = TAU * hz / sample_rate;
        (w0.cos(), w0.sin() / (2.0 * q))
    }

    fn normalised(b0: f64, b1: f64, b2: f64, a0: f64, a1: f64, a2: f64) -> Self {
        Self {
            b0: (b0 / a0) as f32,
            b1: (b1 / a0) as f32,
            b2: (b2 / a0) as f32,
            a1: (a1 / a0) as f32,
            a2: (a2 / a0) as f32,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gain_at(mut f: Biquad, sr: f64, hz: f64) -> f32 {
        let n = (sr * 0.5) as usize;
        let mut peak = 0.0_f32;
        for i in 0..n {
            let y = f.process((TAU * hz * i as f64 / sr).sin() as f32);
            if i > n / 2 {
                peak = peak.max(y.abs());
            }
        }
        peak
    }

    #[test]
    fn lowpass_and_highpass_split_the_spectrum() {
        let sr = 44_100.0;
        let lp = Biquad::lowpass(sr, 150.0, BUTTERWORTH_Q);
        let hp = Biquad::highpass(sr, 150.0, BUTTERWORTH_Q);
        assert!(gain_at(lp, sr, 40.0) > 0.95);
        assert!(gain_at(lp, sr, 2000.0) < 0.01);
        assert!(gain_at(hp, sr, 40.0) < 0.1);
        assert!(gain_at(hp, sr, 2000.0) > 0.95);
    }
}
