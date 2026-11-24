//! Which beat of the grid is beat one of the bar.
//!
//! Two cues, both genre-agnostic: section changes (intro to drop, drop to breakdown)
//! happen on bar starts, and the kick is strongest on beat one. Section changes are
//! measured with one-bar windows either side of a beat, which average out the
//! pattern inside a bar, so they only respond to real structural changes.

use crate::features::Features;
use crate::tempo::Grid;

pub struct Downbeat {
    /// The first downbeat, at most [`FIRST_BAR_TOLERANCE_S`] before the start of the file.
    pub first_s: f64,
    pub confidence: f32,
}

pub fn find(f: &Features, grid: &Grid, beats_per_bar: u32, duration_s: f64) -> Downbeat {
    let bpb = beats_per_bar.max(1) as usize;
    let beats: Vec<f64> = (0..)
        .map(|k| grid.phase_s + k as f64 * grid.beat_s)
        .take_while(|&t| t + grid.beat_s <= duration_s)
        .collect();
    if bpb == 1 || beats.len() < 4 * bpb {
        return Downbeat {
            first_s: grid.phase_s,
            confidence: if bpb == 1 { 1.0 } else { 0.0 },
        };
    }

    // Low-end level per beat, in dB, and the kick onset strength at each beat.
    // Only frames whose whole window lies inside the beat, so a drop does not leak
    // into the beat before it; the floor keeps silence from dominating.
    let margin = f.half_window_s();
    let level: Vec<f64> = beats
        .iter()
        .map(|&t| {
            let r = f.frames_between(t + margin, t + grid.beat_s - margin);
            let n = r.len().max(1) as f64;
            10.0 * (f.low[r].iter().map(|&x| x as f64).sum::<f64>() / n + 1e-6).log10()
        })
        .collect();
    let kick: Vec<f64> = beats
        .iter()
        .map(|&t| {
            let c = f.frame_at(t);
            let r = c.saturating_sub(1)..(c + 2).min(f.len());
            f.low_flux[r].iter().fold(0.0_f64, |m, &x| m.max(x as f64))
        })
        .collect();

    // Snare strength at each beat: in drum and bass the snare lands on beats 2 and 4.
    let snare: Vec<f64> = beats
        .iter()
        .map(|&t| {
            let c = f.frame_at(t);
            let r = c.saturating_sub(1)..(c + 2).min(f.len());
            f.mid_flux[r].iter().fold(0.0_f64, |m, &x| m.max(x as f64))
        })
        .collect();

    // Change in level across each beat, one bar either side.
    let novelty: Vec<f64> = (0..beats.len())
        .map(|k| {
            if k < bpb || k + bpb > beats.len() {
                return 0.0;
            }
            let before = level[k - bpb..k].iter().sum::<f64>() / bpb as f64;
            let after = level[k..k + bpb].iter().sum::<f64>() / bpb as f64;
            (after - before).abs()
        })
        .collect();
    // Small wobbles inside a section are not structure.
    let threshold = 0.2 * novelty.iter().cloned().fold(0.0, f64::max);

    let mut structure = vec![0.0_f64; bpb];
    let mut kicks = vec![0.0_f64; bpb];
    let mut snares = vec![0.0_f64; bpb];
    let mut counts = vec![0usize; bpb];
    for k in 0..beats.len() {
        kicks[k % bpb] += kick[k];
        snares[k % bpb] += snare[k];
        counts[k % bpb] += 1;
        // A change also shows, weaker, on the beats around it; count only its peak.
        let near = k.saturating_sub(bpb / 2)..(k + bpb / 2 + 1).min(beats.len());
        if novelty[k] > threshold && novelty[near].iter().all(|&n| n <= novelty[k]) {
            structure[k % bpb] += novelty[k];
        }
    }
    for ((k, s), c) in kicks.iter_mut().zip(snares.iter_mut()).zip(&counts) {
        *k /= (*c).max(1) as f64;
        *s /= (*c).max(1) as f64;
    }
    let normalise = |v: &mut [f64]| {
        let max = v.iter().cloned().fold(0.0, f64::max);
        if max > 0.0 {
            v.iter_mut().for_each(|x| *x /= max);
        }
    };
    normalise(&mut structure);
    normalise(&mut kicks);
    normalise(&mut snares);

    // The backbeat: with four beats to the bar, beat one is followed by snares on two
    // and four and has none itself. It tells beat one from the beat before it, where
    // a pickup hit into a drop can fool the other cues.
    let backbeat = |p: usize| {
        if bpb == 4 {
            snares[(p + 1) % 4] + snares[(p + 3) % 4] - snares[p] - snares[(p + 2) % 4]
        } else {
            0.0
        }
    };
    let scores: Vec<f64> = (0..bpb)
        .map(|p| structure[p] + 0.5 * kicks[p] + BACKBEAT_WEIGHT * backbeat(p))
        .collect();
    let mut ranked: Vec<usize> = (0..bpb).collect();
    ranked.sort_by(|&a, &b| scores[b].total_cmp(&scores[a]));
    let (best, second) = (scores[ranked[0]], scores[ranked[1]]);
    let confidence = if best > 0.0 {
        (3.0 * (best - second) / best).clamp(0.0, 1.0)
    } else {
        0.0
    };

    // Many files start right on a downbeat, which the grid can place a hair before
    // zero; count that as bar 0 rather than numbering every bar one off.
    let bar_s = grid.beat_s * bpb as f64;
    let mut first_s = beats[ranked[0]];
    while first_s - bar_s > -FIRST_BAR_TOLERANCE_S {
        first_s -= bar_s;
    }

    Downbeat {
        first_s,
        confidence: confidence as f32,
    }
}

/// How far before the start of the file bar 0 may begin.
pub const FIRST_BAR_TOLERANCE_S: f64 = 0.05;

/// How much the snare pattern counts against the other downbeat cues.
const BACKBEAT_WEIGHT: f64 = 0.5;
