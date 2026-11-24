//! Key from the track's pitch-class profile, matched against the Krumhansl-Kessler
//! key profiles for all 24 major and minor keys (from double-drop, commit 9d3a720).

/// Krumhansl-Kessler profiles from listening tests, starting at the tonic.
const MAJOR: [f64; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR: [f64; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];
/// A margin this big between the best key and the next one is as sure as it gets.
const SURE_MARGIN: f64 = 0.15;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Key {
    /// Pitch class of the tonic: 0 = C, 1 = C#, ..., 11 = B.
    pub tonic: u8,
    pub minor: bool,
    pub confidence: f32,
}

pub fn estimate(chroma: &[f32; 12]) -> Option<Key> {
    if chroma.iter().all(|&x| x <= 0.0) {
        return None;
    }
    let mut scores: Vec<(f64, u8, bool)> = Vec::with_capacity(24);
    for tonic in 0..12u8 {
        for (minor, profile) in [(false, &MAJOR), (true, &MINOR)] {
            let rotated: Vec<f64> = (0..12)
                .map(|pc| chroma[(pc + tonic as usize) % 12] as f64)
                .collect();
            scores.push((pearson(&rotated, profile), tonic, minor));
        }
    }
    scores.sort_by(|a, b| b.0.total_cmp(&a.0));
    let (best, tonic, minor) = scores[0];
    let margin = best - scores[1].0;
    Some(Key {
        tonic,
        minor,
        confidence: (margin / SURE_MARGIN).clamp(0.0, 1.0) as f32,
    })
}

fn pearson(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len() as f64;
    let (ma, mb) = (a.iter().sum::<f64>() / n, b.iter().sum::<f64>() / n);
    let cov: f64 = a.iter().zip(b).map(|(x, y)| (x - ma) * (y - mb)).sum();
    let va: f64 = a.iter().map(|x| (x - ma).powi(2)).sum();
    let vb: f64 = b.iter().map(|y| (y - mb).powi(2)).sum();
    if va == 0.0 || vb == 0.0 {
        0.0
    } else {
        cov / (va * vb).sqrt()
    }
}
