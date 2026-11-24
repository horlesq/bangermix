//! Waveform data for drawing: per short column of time, the peak level and the level
//! of the low, mid and high bands, for 3-band colouring (from double-drop
//! `dd-core::waveform`, commit 9d3a720).

use bm_dsp::{Biquad, BUTTERWORTH_Q};

/// Below this is the low band (sub-bass and kick), as in the engine's crossover.
pub const LOW_HZ: f64 = 150.0;
/// Above this is the high band (hats, cymbals).
pub const HIGH_HZ: f64 = 2500.0;

/// Four bytes per column: peak, low, mid, high, each 0 to 255.
pub struct Waveform {
    pub columns_per_s: f64,
    pub data: Vec<u8>,
}

pub fn build(mono: &[f32], sample_rate: u32, columns_per_s: f64) -> Waveform {
    let sr = sample_rate as f64;
    let low_lp = Biquad::lowpass(sr, LOW_HZ, BUTTERWORTH_Q);
    let low_hp = Biquad::highpass(sr, LOW_HZ, BUTTERWORTH_Q);
    let high_lp = Biquad::lowpass(sr, HIGH_HZ, BUTTERWORTH_Q);
    let high_hp = Biquad::highpass(sr, HIGH_HZ, BUTTERWORTH_Q);
    let mut low = [low_lp, low_lp];
    let mut mid = [low_hp, low_hp, high_lp, high_lp];
    let mut high = [high_hp, high_hp];

    let frames_per_column = sr / columns_per_s;
    let columns = (mono.len() as f64 / frames_per_column).ceil() as usize;
    let mut data = Vec::with_capacity(columns * 4);
    let mut column_end = frames_per_column;
    let (mut peak, mut sums, mut count) = (0.0f32, [0.0f64; 3], 0u32);
    let level = |x: f32| (x * 255.0).round().clamp(0.0, 255.0) as u8;
    let mut end_column = |peak: &mut f32, sums: &mut [f64; 3], count: &mut u32| {
        // Scaled by sqrt(2) so a full-scale sine, whose RMS is 1/sqrt(2), reads 255.
        let n = (*count).max(1) as f64;
        let [l, m, h] = sums.map(|s| level((s / n).sqrt() as f32 * std::f32::consts::SQRT_2));
        data.extend_from_slice(&[level(*peak), l, m, h]);
        *peak = 0.0;
        *sums = [0.0; 3];
        *count = 0;
    };
    for (i, &x) in mono.iter().enumerate() {
        let lo = low.iter_mut().fold(x, |v, f| f.process(v));
        let mi = mid.iter_mut().fold(x, |v, f| f.process(v));
        let hi = high.iter_mut().fold(x, |v, f| f.process(v));
        peak = peak.max(x.abs());
        sums[0] += (lo * lo) as f64;
        sums[1] += (mi * mi) as f64;
        sums[2] += (hi * hi) as f64;
        count += 1;
        if (i + 1) as f64 >= column_end {
            end_column(&mut peak, &mut sums, &mut count);
            column_end += frames_per_column;
        }
    }
    if count > 0 {
        end_column(&mut peak, &mut sums, &mut count);
    }
    Waveform {
        columns_per_s,
        data,
    }
}
