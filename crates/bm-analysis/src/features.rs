//! Frame-level features from a short-time Fourier transform of a downsampled mono copy.

use bm_dsp::{Biquad, BUTTERWORTH_Q};
use rustfft::{num_complex::Complex32, FftPlanner};

/// Analysis runs at about this rate: plenty for beats, bass and key, and cheap.
const TARGET_RATE: f64 = 11_025.0;
const FRAME: usize = 512;
const HOP: usize = 128;
const CHROMA_FRAME: usize = 8192;

pub const LOW_MAX_HZ: f64 = 150.0;
pub const HIGH_MIN_HZ: f64 = 2000.0;

pub struct Features {
    /// Seconds between frames.
    pub hop_s: f64,
    /// Time of frame 0's centre.
    pub offset_s: f64,
    /// Onset strength (spectral flux) per frame, all bands and the low band.
    pub flux: Vec<f32>,
    pub low_flux: Vec<f32>,
    /// Onset strength between the low end and 2 kHz: where snares hit.
    pub mid_flux: Vec<f32>,
    /// Mean-square level per frame: all bands, below 150 Hz, above 2 kHz.
    pub energy: Vec<f32>,
    pub low: Vec<f32>,
    pub high: Vec<f32>,
    /// Pitch-class profile of the whole track (C, C#, ..., B).
    pub chroma: [f32; 12],
}

impl Features {
    /// Half the analysis window: a frame hears this far either side of its centre.
    pub fn half_window_s(&self) -> f64 {
        self.offset_s
    }

    /// The frame whose centre is nearest to `time_s`.
    pub fn frame_at(&self, time_s: f64) -> usize {
        ((time_s - self.offset_s) / self.hop_s).round().max(0.0) as usize
    }

    pub fn len(&self) -> usize {
        self.flux.len()
    }

    /// Frames whose centres fall in `[start_s, end_s)`.
    pub fn frames_between(&self, start_s: f64, end_s: f64) -> std::ops::Range<usize> {
        let first = ((start_s - self.offset_s) / self.hop_s).ceil().max(0.0) as usize;
        let end = ((end_s - self.offset_s) / self.hop_s).ceil().max(0.0) as usize;
        first.min(self.len())..end.min(self.len())
    }
}

#[allow(dead_code)]
pub fn extract(mono: &[f32], sample_rate: u32) -> Features {
    let (x, rate) = decimate(mono, sample_rate as f64);
    extract_decimated(&x, rate)
}

/// Features of a signal already at the analysis rate (see [`decimate`]).
pub fn extract_decimated(x: &[f32], rate: f64) -> Features {
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FRAME);
    let window = hann(FRAME);
    // Scale so a sine of amplitude A shows magnitude A in its bin.
    let scale = 2.0 / window.iter().sum::<f32>();
    let bin_hz = rate / FRAME as f64;
    let low_bins = 1..=((LOW_MAX_HZ / bin_hz) as usize);
    let high_from = (HIGH_MIN_HZ / bin_hz).ceil() as usize;
    let bins = FRAME / 2;

    let frames = if x.len() >= FRAME {
        (x.len() - FRAME) / HOP + 1
    } else {
        0
    };
    let mut f = Features {
        hop_s: HOP as f64 / rate,
        offset_s: (FRAME / 2) as f64 / rate,
        flux: Vec::with_capacity(frames),
        low_flux: Vec::with_capacity(frames),
        mid_flux: Vec::with_capacity(frames),
        energy: Vec::with_capacity(frames),
        low: Vec::with_capacity(frames),
        high: Vec::with_capacity(frames),
        chroma: chroma(x, rate, &mut planner),
    };
    let mut buf = vec![Complex32::default(); FRAME];
    let mut prev = vec![0.0_f32; bins];
    for i in 0..frames {
        let chunk = &x[i * HOP..i * HOP + FRAME];
        for ((b, &s), &w) in buf.iter_mut().zip(chunk).zip(&window) {
            *b = Complex32::new(s * w, 0.0);
        }
        fft.process(&mut buf);
        let (mut flux, mut low_flux, mut mid_flux, mut energy, mut low, mut high) =
            (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        for k in 1..bins {
            let mag = buf[k].norm() * scale;
            let power = 0.5 * mag * mag;
            let compressed = (1.0 + 100.0 * mag).ln();
            let rise = (compressed - prev[k]).max(0.0);
            prev[k] = compressed;
            flux += rise;
            energy += power;
            if low_bins.contains(&k) {
                low_flux += rise;
                low += power;
            } else if k >= high_from {
                high += power;
            } else {
                mid_flux += rise;
            }
        }
        f.flux.push(flux);
        f.low_flux.push(low_flux);
        f.mid_flux.push(mid_flux);
        f.energy.push(energy);
        f.low.push(low);
        f.high.push(high);
    }
    f
}

/// Low-pass and downsample by an integer factor to about [`TARGET_RATE`].
pub fn decimate(x: &[f32], rate: f64) -> (Vec<f32>, f64) {
    let factor = (rate / TARGET_RATE).round().max(1.0) as usize;
    let out_rate = rate / factor as f64;
    if factor == 1 {
        return (x.to_vec(), out_rate);
    }
    let cutoff = 0.45 * out_rate;
    let mut stages = [
        Biquad::lowpass(rate, cutoff, BUTTERWORTH_Q),
        Biquad::lowpass(rate, cutoff, BUTTERWORTH_Q),
    ];
    // Every sample must pass through the filters, so no iterator skipping here.
    let mut out = Vec::with_capacity(x.len() / factor + 1);
    for (i, &s) in x.iter().enumerate() {
        let y = stages.iter_mut().fold(s, |v, f| f.process(v));
        if i % factor == 0 {
            out.push(y);
        }
    }
    (out, out_rate)
}

fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos()) as f32)
        .collect()
}

/// Pitch-class energy from 55 Hz to 1760 Hz over the whole track.
fn chroma(x: &[f32], rate: f64, planner: &mut FftPlanner<f32>) -> [f32; 12] {
    let mut chroma = [0.0_f32; 12];
    if x.len() < CHROMA_FRAME {
        return chroma;
    }
    let fft = planner.plan_fft_forward(CHROMA_FRAME);
    let window = hann(CHROMA_FRAME);
    let bin_hz = rate / CHROMA_FRAME as f64;
    // Each bin's pitch class and weight (1 on a semitone, 0 halfway between).
    let map: Vec<(usize, usize, f32)> = (1..CHROMA_FRAME / 2)
        .filter_map(|k| {
            let hz = k as f64 * bin_hz;
            if !(55.0..=1760.0).contains(&hz) {
                return None;
            }
            let midi = 69.0 + 12.0 * (hz / 440.0).log2();
            let nearest = midi.round();
            let weight = (1.0 - 2.0 * (midi - nearest).abs()) as f32;
            (weight > 0.0).then_some((k, nearest as usize % 12, weight))
        })
        .collect();
    let mut buf = vec![Complex32::default(); CHROMA_FRAME];
    for start in (0..=x.len() - CHROMA_FRAME).step_by(CHROMA_FRAME / 2) {
        for ((b, &s), &w) in buf
            .iter_mut()
            .zip(&x[start..start + CHROMA_FRAME])
            .zip(&window)
        {
            *b = Complex32::new(s * w, 0.0);
        }
        fft.process(&mut buf);
        for &(k, pc, weight) in &map {
            chroma[pc] += weight * buf[k].norm();
        }
    }
    chroma
}
