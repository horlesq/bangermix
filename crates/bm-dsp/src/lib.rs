//! bangermix DSP building blocks, shared by the engine and the analysis.
//!
//! Most of this comes from double-drop (`dd-core::dsp` and `dd-engine`, commit
//! 9d3a720). Nothing here allocates once it is built, so all of it is safe to use on
//! the audio thread.

pub mod biquad;
mod filter;
mod isolator;
mod limiter;
mod svf;

pub use biquad::{Biquad, BUTTERWORTH_Q};
pub use filter::DjFilter;
pub use isolator::{Isolator, CROSSOVER_HZ, HIGH_CROSSOVER_HZ};
pub use limiter::Limiter;
pub use svf::{Svf, SvfOut};

/// The sample at fractional index `pos`, by cubic (Catmull-Rom) interpolation.
/// Outside the buffer is silence.
#[inline]
pub fn sample_at(channel: &[f32], pos: f64) -> f32 {
    let i = pos.floor();
    let t = (pos - i) as f32;
    let i = i as i64;
    let n = channel.len() as i64;
    if i >= 1 && i + 2 < n {
        // The fast path: all four points inside the buffer.
        let i = i as usize;
        return cubic(
            channel[i - 1],
            channel[i],
            channel[i + 1],
            channel[i + 2],
            t,
        );
    }
    let at = |k: i64| {
        if k >= 0 && k < n {
            channel[k as usize]
        } else {
            0.0
        }
    };
    cubic(at(i - 1), at(i), at(i + 1), at(i + 2), t)
}

#[inline]
fn cubic(y0: f32, y1: f32, y2: f32, y3: f32, t: f32) -> f32 {
    let c1 = 0.5 * (y2 - y0);
    let c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    ((c3 * t + c2) * t + c1) * t + y1
}

/// A value that glides to its target instead of jumping, so moving a knob or fader
/// does not click ("zipper noise").
#[derive(Clone, Copy, Debug)]
pub struct Smoothed {
    pub value: f32,
    pub target: f32,
    coef: f32,
}

impl Smoothed {
    /// Glides with a time constant of `time_s`.
    pub fn new(value: f32, sample_rate: f64, time_s: f64) -> Self {
        Self {
            value,
            target: value,
            coef: (1.0 - (-1.0 / (time_s * sample_rate)).exp()) as f32,
        }
    }

    #[inline]
    pub fn tick(&mut self) -> f32 {
        self.value += (self.target - self.value) * self.coef;
        // f32 steps stall a few millionths short of the target; finish the glide.
        if (self.target - self.value).abs() < 1e-4 {
            self.value = self.target;
        }
        self.value
    }
}

/// Decibels to a linear gain.
#[inline]
pub fn db_to_gain(db: f32) -> f32 {
    10f32.powf(db / 20.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interpolation_hits_the_samples_and_is_silent_outside() {
        let x = [0.0, 1.0, 0.5, -0.5, 0.25];
        for (i, &v) in x.iter().enumerate() {
            assert!((sample_at(&x, i as f64) - v).abs() < 1e-6);
        }
        assert_eq!(sample_at(&x, -10.0), 0.0);
        assert_eq!(sample_at(&x, 10.0), 0.0);
    }

    #[test]
    fn smoothing_reaches_its_target() {
        let mut s = Smoothed::new(0.0, 48_000.0, 0.005);
        s.target = 1.0;
        for _ in 0..4800 {
            s.tick();
        }
        assert_eq!(s.value, 1.0);
    }
}
