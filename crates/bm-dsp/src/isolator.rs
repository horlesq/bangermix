//! A three-band isolator EQ (from double-drop `dd-engine`, commit 9d3a720).

use crate::biquad::{Biquad, BUTTERWORTH_Q};

/// Where the low end (bass) is split from the mids.
pub const CROSSOVER_HZ: f64 = 150.0;
/// Where the mids are split from the highs.
pub const HIGH_CROSSOVER_HZ: f64 = 2500.0;

/// Linkwitz-Riley 4th-order crossovers at [`CROSSOVER_HZ`] and [`HIGH_CROSSOVER_HZ`].
/// The low band goes through an all-pass matching the upper crossover's phase, so with
/// every band at full level the three sum back to the input's magnitude and the track
/// sounds unchanged. Each band's gain can go from 0 (killed) to above 1 (boost).
#[derive(Clone, Debug)]
pub struct Isolator {
    low: [Biquad; 2],
    low_phase: Biquad,
    rest: [Biquad; 2],
    mid: [Biquad; 2],
    high: [Biquad; 2],
}

impl Isolator {
    pub fn new(sample_rate: f64) -> Self {
        let lp = Biquad::lowpass(sample_rate, CROSSOVER_HZ, BUTTERWORTH_Q);
        let hp = Biquad::highpass(sample_rate, CROSSOVER_HZ, BUTTERWORTH_Q);
        let mid = Biquad::lowpass(sample_rate, HIGH_CROSSOVER_HZ, BUTTERWORTH_Q);
        let high = Biquad::highpass(sample_rate, HIGH_CROSSOVER_HZ, BUTTERWORTH_Q);
        Self {
            low: [lp, lp],
            low_phase: Biquad::allpass(sample_rate, HIGH_CROSSOVER_HZ, BUTTERWORTH_Q),
            rest: [hp, hp],
            mid: [mid, mid],
            high: [high, high],
        }
    }

    /// The input with its low, mid and high bands at the given gains.
    #[inline]
    pub fn process(&mut self, x: f32, [low, mid, high]: [f32; 3]) -> f32 {
        let cascade = |filters: &mut [Biquad; 2], x: f32| {
            let y = filters[0].process(x);
            filters[1].process(y)
        };
        let lo = self.low_phase.process(cascade(&mut self.low, x));
        let rest = cascade(&mut self.rest, x);
        let mi = cascade(&mut self.mid, rest);
        let hi = cascade(&mut self.high, rest);
        lo * low + mi * mid + hi * high
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    fn level(gains: [f32; 3], hz: f64) -> f32 {
        let sr = 48_000.0;
        let mut iso = Isolator::new(sr);
        // RMS scaled to a sine's peak: at high frequencies the samples miss the peaks.
        let mut sum = 0.0f64;
        for i in 0..48_000 {
            let y = iso.process((TAU * hz * i as f64 / sr).sin() as f32, gains);
            if i >= 24_000 {
                sum += (y * y) as f64;
            }
        }
        ((sum / 24_000.0).sqrt() * std::f64::consts::SQRT_2) as f32
    }

    #[test]
    fn flat_when_open_and_kills_each_band() {
        for hz in [50.0, 800.0, 8000.0] {
            assert!((level([1.0; 3], hz) - 1.0).abs() < 0.05, "{hz} Hz");
        }
        assert!(level([0.0, 1.0, 1.0], 40.0) < 0.05);
        assert!(level([1.0, 0.0, 1.0], 700.0) < 0.1);
        assert!(level([1.0, 1.0, 0.0], 12_000.0) < 0.05);
    }
}
