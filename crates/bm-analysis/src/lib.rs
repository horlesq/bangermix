//! bangermix track analysis: tempo, beat grid, downbeat, key, loudness and waveform.
//!
//! Runs on a downsampled mono copy (about 11 kHz), enough for beats and key and cheap.
//! The tempo, downbeat and attack code comes from double-drop (`dd-analysis`, commit
//! 9d3a720), with the drum-and-bass specifics left out and a general tempo range.

mod attacks;
mod downbeat;
mod features;
mod key;
mod tempo;
pub mod waveform;

pub use key::Key;

/// The tempo range a grid is looked for in. Keep it within an octave (max below twice
/// min), so a track has one answer: 87 or 174 is the range's choice.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TempoRange {
    pub min_bpm: f64,
    pub max_bpm: f64,
}

impl Default for TempoRange {
    fn default() -> Self {
        Self {
            min_bpm: 88.0,
            max_bpm: 175.0,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Analysis {
    pub duration_s: f64,
    /// 0 when no steady beat was found.
    pub bpm: f64,
    /// The first downbeat (beat one of a bar), in seconds; may be a little negative.
    pub anchor_s: f64,
    pub grid_confidence: f32,
    pub downbeat_confidence: f32,
    pub key: Option<Key>,
    /// Loudness of the loud parts, dB relative to full scale (for auto gain).
    pub loudness_db: f32,
}

pub fn analyse(mono: &[f32], sample_rate: u32, range: TempoRange) -> Analysis {
    let duration_s = mono.len() as f64 / sample_rate as f64;
    let (x, rate) = features::decimate(mono, sample_rate as f64);
    let f = features::extract_decimated(&x, rate);
    let key = key::estimate(&f.chroma);
    let loudness_db = loudness(&f);
    let mut out = Analysis {
        duration_s,
        bpm: 0.0,
        anchor_s: 0.0,
        grid_confidence: 0.0,
        downbeat_confidence: 0.0,
        key,
        loudness_db,
    };
    let Some(grid) = tempo::estimate(&f, range) else {
        return out;
    };
    let down = downbeat::find(&f, &grid, 4, duration_s);
    // Move the grid onto the track's own attacks, so two tracks' hits land together.
    let strength = attacks::strength(&x, rate);
    let beats = (0..)
        .map(|k| down.first_s + k as f64 * grid.beat_s)
        .take_while(|&t| t < duration_s);
    let shift = attacks::offset(&strength, rate, beats).unwrap_or(0.0);
    out.bpm = grid.bpm;
    out.anchor_s = down.first_s + shift;
    out.grid_confidence = grid.confidence;
    out.downbeat_confidence = down.confidence;
    out
}

/// The 90th percentile of the level over 0.4 s windows, in dB.
fn loudness(f: &features::Features) -> f32 {
    let per = ((0.4 / f.hop_s) as usize).max(1);
    let mut windows: Vec<f64> = f
        .energy
        .chunks(per)
        .map(|c| c.iter().map(|&e| e as f64).sum::<f64>() / c.len() as f64)
        .collect();
    if windows.is_empty() {
        return -100.0;
    }
    windows.sort_by(f64::total_cmp);
    let p = windows[((windows.len() - 1) as f64 * 0.9) as usize];
    (10.0 * (p + 1e-12).log10()) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Four-on-the-floor kicks with a hat on the off-beat and a snare on 2 and 4, and
    /// a bar-long accent every four bars so the downbeat can be found.
    fn beat(bpm: f64, seconds: f64, first_s: f64, rate: u32) -> Vec<f32> {
        let sr = rate as f64;
        let mut x = vec![0.0f32; (seconds * sr) as usize];
        let beat_s = 60.0 / bpm;
        let mut k = 0usize;
        loop {
            let t = first_s + k as f64 * beat_s;
            if t >= seconds - 0.5 {
                break;
            }
            let i = (t * sr) as usize;
            let kick_gain = if k.is_multiple_of(4) { 1.0 } else { 0.7 };
            for n in 0..(0.12 * sr) as usize {
                let tt = n as f64 / sr;
                let f = 50.0 + 100.0 * (-tt * 30.0).exp();
                x[i + n] += (kick_gain
                    * (-tt * 25.0).exp()
                    * (std::f64::consts::TAU * f * tt).sin()) as f32
                    * 0.8;
            }
            let hat = ((t + beat_s / 2.0) * sr) as usize;
            let mut seed = 12345u32.wrapping_add(k as u32);
            for n in 0..(0.03 * sr) as usize {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
                let noise = (seed >> 16) as f32 / 32768.0 - 1.0;
                if hat + n < x.len() {
                    x[hat + n] += noise * 0.2 * (-(n as f32) / (0.005 * sr as f32)).exp();
                }
            }
            if !k.is_multiple_of(2) {
                for n in 0..(0.08 * sr) as usize {
                    seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
                    let noise = (seed >> 16) as f32 / 32768.0 - 1.0;
                    x[i + n] += noise * 0.35 * (-(n as f32) / (0.02 * sr as f32)).exp();
                }
            }
            k += 1;
        }
        x
    }

    #[test]
    fn finds_tempo_and_grid() {
        for (bpm, first) in [(128.0, 0.21), (174.0, 0.05), (95.5, 0.4)] {
            let x = beat(bpm, 60.0, first, 44_100);
            let a = analyse(&x, 44_100, TempoRange::default());
            assert!((a.bpm - bpm).abs() < 0.02, "{} for {bpm}", a.bpm);
            // On a beat line (which beat is the bar's first is harder; not checked here).
            let beat_s = 60.0 / bpm;
            let off = ((a.anchor_s - first) / beat_s + 0.5).rem_euclid(1.0) - 0.5;
            assert!(
                off.abs() * beat_s < 0.01,
                "{} ms off for {bpm}",
                off * beat_s * 1e3
            );
        }
    }

    #[test]
    fn waveform_has_four_bytes_per_column() {
        let x = beat(128.0, 10.0, 0.0, 44_100);
        let w = waveform::build(&x, 44_100, 100.0);
        assert_eq!(w.data.len(), 1000 * 4);
        assert!(
            w.data.chunks(4).any(|c| c[1] > 50),
            "kicks show in the low band"
        );
    }
}
