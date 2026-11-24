//! Where exactly in the beat a track's hits land, to the millisecond.
//!
//! The tempo grid is fitted to every onset, so where its beat lines fall within the
//! hits differs from track to track by up to tens of milliseconds, and two tracks
//! whose hits land 10 ms apart flam. So each grid is moved onto its own attacks.
//!
//! Attacks are timed in the high band, where the click of the kick, the crack of the
//! snare and the hats are: what the ear times a beat by. The low end is no good for
//! it: how soon a kick's sub swells depends on the kick, by up to 30 ms (Siren (feat.
//! Knytro) against Wilkinson - Decompression), and in a double drop the outgoing
//! track's low end is off anyway. One hit is not enough either, so the attacks are
//! folded over many beats: all the beats of a drop's first 16 bars, the stretch that
//! plays against the other track.

use bm_dsp::{Biquad, BUTTERWORTH_Q};

/// The high band starts here.
const HIGH_HZ: f64 = 1000.0;
/// Attacks are looked for this far either side of each beat line: well inside the
/// sixteenth notes either side (86 ms away at 174 BPM), which carry hats too.
const SEARCH_S: f64 = 0.05;
/// A peak this close to the edge of the search may be the side of an attack outside it.
const EDGE_S: f64 = 0.005;
/// Fewer beats than this do not tell.
const MIN_BEATS: usize = 16;
/// The folded attack strength must peak at least this far above its mean.
const MIN_SHARPNESS: f64 = 2.0;
/// How far behind the start of a hit its attack measure lands (the rise of its
/// envelope), measured on synthetic drums: the grid goes this much before the peak.
pub const LEAD_S: f64 = 0.0015;

/// How fast the high band rises, sample by sample.
pub fn strength(x: &[f32], rate: f64) -> Vec<f32> {
    let mut high = [
        Biquad::highpass(rate, HIGH_HZ, BUTTERWORTH_Q),
        Biquad::highpass(rate, HIGH_HZ, BUTTERWORTH_Q),
    ];
    let rectified: Vec<f32> = x
        .iter()
        .map(|&s| high.iter_mut().fold(s, |v, f| f.process(v)).abs())
        .collect();
    // A 1 ms running maximum is the envelope, without the ripple of single cycles...
    let w = ((0.001 * rate) as usize).max(1);
    let envelope: Vec<f32> = (0..rectified.len())
        .map(|i| {
            rectified[i.saturating_sub(w)..=i]
                .iter()
                .cloned()
                .fold(0.0, f32::max)
        })
        .collect();
    // ...and its rise over 2 ms is the attack.
    let d = ((0.002 * rate) as usize).max(1);
    (0..envelope.len())
        .map(|i| {
            if i < d {
                0.0
            } else {
                (envelope[i] - envelope[i - d]).max(0.0)
            }
        })
        .collect()
}

/// Where the attacks land around the beat lines `beats` (seconds), relative to them:
/// the peak of the attack [`strength`] folded over all of them, minus [`LEAD_S`], so
/// it is where the grid should be. `None` when that is not clear.
pub fn offset(strength: &[f32], rate: f64, beats: impl IntoIterator<Item = f64>) -> Option<f64> {
    let half = (SEARCH_S * rate).round() as i64;
    let mut fold = vec![0.0f64; (2 * half + 1) as usize];
    let mut n = 0;
    for t in beats {
        let c = (t * rate).round() as i64;
        if c - half < 0 || c + half >= strength.len() as i64 {
            continue;
        }
        for (j, v) in fold.iter_mut().enumerate() {
            *v += strength[(c - half) as usize + j] as f64;
        }
        n += 1;
    }
    if n < MIN_BEATS {
        return None;
    }
    // Smoothed over a millisecond, so the peak is the attack's, not one sample's.
    let r = ((0.0005 * rate) as usize).max(1);
    let smooth: Vec<f64> = (0..fold.len())
        .map(|i| {
            let span = &fold[i.saturating_sub(r)..(i + r + 1).min(fold.len())];
            span.iter().sum::<f64>() / span.len() as f64
        })
        .collect();
    let (best, peak) =
        smooth.iter().enumerate().fold(
            (0, 0.0),
            |(bi, bv), (i, &v)| if v > bv { (i, v) } else { (bi, bv) },
        );
    let mean = smooth.iter().sum::<f64>() / smooth.len() as f64;
    let edge = (EDGE_S * rate) as usize;
    if peak <= 0.0 || peak < MIN_SHARPNESS * mean || best < edge || best + edge >= smooth.len() {
        return None;
    }
    Some((best as i64 - half) as f64 / rate - LEAD_S)
}
