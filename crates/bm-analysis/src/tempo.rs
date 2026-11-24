//! Tempo and beat grid: a constant-tempo grid fitted to the onset strength.
//!
//! For each candidate tempo in the profile's range, the whole track's onset strength
//! is folded onto one beat period: the tempo whose fold has the sharpest peak wins
//! (coarse steps first, then fine ones), and the peak gives the beat phase. Fitting the whole
//! track makes the grid accurate to a few milliseconds even at the last bar.
//!
//! Tracks with tempo changes need a beat tracker instead (the "Beat This!" model is
//! planned); the confidence drops when the two halves of a track disagree.

use crate::features::Features;
use crate::TempoRange;

/// Bins per beat when folding.
const PHASE_BINS: usize = 96;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grid {
    pub bpm: f64,
    pub beat_s: f64,
    /// Time of a beat, in `[0, beat_s)`.
    pub phase_s: f64,
    pub confidence: f32,
}

pub fn estimate(f: &Features, range: TempoRange) -> Option<Grid> {
    let onset = onset_envelope(&f.flux, f.hop_s);
    if onset.len() < 8 || onset.iter().all(|&x| x == 0.0) {
        return None;
    }
    // Coarse pass over the whole range, then a fine pass around the best tempo.
    let all = 0..onset.len();
    let search = |from: f64, to: f64, step: f64| {
        let mut best: Option<(f64, Fold)> = None;
        let mut i = 0;
        loop {
            let bpm = from + i as f64 * step;
            if bpm > to + 1e-9 {
                break best;
            }
            let fold = fold(&onset, f.hop_s, 60.0 / bpm, all.clone());
            if best.as_ref().is_none_or(|(_, b)| fold.peak > b.peak) {
                best = Some((bpm, fold));
            }
            i += 1;
        }
    };
    let (coarse, _) = search(range.min_bpm, range.max_bpm, 0.02)?;
    let best = search(coarse - 0.03, coarse + 0.03, 0.001);
    let (mut bpm, mut whole) = best?;
    // Most dance music is made at a whole (or half) BPM: take it when it fits about
    // as well, so grids read 128.00 rather than 127.98.
    for step in [1.0, 0.5] {
        let round = (bpm / step).round() * step;
        if (round - bpm).abs() < 0.04 && (round - bpm).abs() > 1e-9 {
            let fold = fold(&onset, f.hop_s, 60.0 / round, all.clone());
            if fold.peak >= 0.97 * whole.peak {
                bpm = round;
                whole = fold;
                break;
            }
        }
    }
    let beat_s = 60.0 / bpm;

    // Sharpness of the fold, and agreement between the two halves of the track.
    let sharpness = whole.peak / whole.mean.max(1e-9);
    let half = onset.len() / 2;
    let first = fold(&onset, f.hop_s, beat_s, 0..half);
    let second = fold(&onset, f.hop_s, beat_s, half..onset.len());
    let drift = circular_distance(first.phase_s, second.phase_s, beat_s);
    let sharp_conf = ((sharpness - 1.5) / 2.0).clamp(0.0, 1.0);
    let agree_conf = (1.0 - drift / 0.03).clamp(0.0, 1.0);

    Some(Grid {
        bpm,
        beat_s,
        phase_s: (whole.phase_s + f.offset_s).rem_euclid(beat_s),
        confidence: (sharp_conf * agree_conf) as f32,
    })
}

/// Spectral flux minus its local average, so only onsets that stand out count.
fn onset_envelope(flux: &[f32], hop_s: f64) -> Vec<f64> {
    let radius = ((0.25 / hop_s) as usize).max(1);
    let mut prefix = vec![0.0_f64; flux.len() + 1];
    for (i, &x) in flux.iter().enumerate() {
        prefix[i + 1] = prefix[i] + x as f64;
    }
    (0..flux.len())
        .map(|i| {
            let (lo, hi) = (i.saturating_sub(radius), (i + radius + 1).min(flux.len()));
            let mean = (prefix[hi] - prefix[lo]) / (hi - lo) as f64;
            (flux[i] as f64 - mean).max(0.0)
        })
        .collect()
}

struct Fold {
    peak: f64,
    mean: f64,
    /// Where the peak sits within the beat, relative to frame 0's time.
    phase_s: f64,
}

/// Folds `onset[frames]` onto one beat period and finds the peak.
fn fold(onset: &[f64], hop_s: f64, beat_s: f64, frames: std::ops::Range<usize>) -> Fold {
    let mut bins = [0.0_f64; PHASE_BINS];
    let per_beat = beat_s / hop_s;
    for i in frames {
        let phase = (i as f64 / per_beat).fract();
        bins[(phase * PHASE_BINS as f64) as usize % PHASE_BINS] += onset[i];
    }
    let smooth: Vec<f64> = (0..PHASE_BINS)
        .map(|b| {
            let prev = bins[(b + PHASE_BINS - 1) % PHASE_BINS];
            let next = bins[(b + 1) % PHASE_BINS];
            0.25 * prev + 0.5 * bins[b] + 0.25 * next
        })
        .collect();
    let (peak_bin, &peak) = smooth
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .expect("bins are not empty");
    // Parabolic interpolation around the peak for sub-bin precision.
    let (l, r) = (
        smooth[(peak_bin + PHASE_BINS - 1) % PHASE_BINS],
        smooth[(peak_bin + 1) % PHASE_BINS],
    );
    let denom = l - 2.0 * peak + r;
    let shift = if denom.abs() > 1e-12 {
        0.5 * (l - r) / denom
    } else {
        0.0
    };
    let phase = (peak_bin as f64 + 0.5 + shift) / PHASE_BINS as f64;
    Fold {
        peak,
        mean: smooth.iter().sum::<f64>() / PHASE_BINS as f64,
        phase_s: phase * beat_s,
    }
}

fn circular_distance(a: f64, b: f64, period: f64) -> f64 {
    let d = (a - b).rem_euclid(period);
    d.min(period - d)
}
