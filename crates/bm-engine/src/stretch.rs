//! Keylock and key shift: WSOLA time-stretching (waveform-similarity overlap-add),
//! the method SoundTouch uses and DJ software has long used for master tempo.
//!
//! The whole track is in memory, so no input buffering is needed. Every hop
//! (`n / 2` output frames) a new grain starts where the deck is, nudged by up to
//! `tol` frames to where it best continues the previous grain's waveform. Grains
//! are read at their own step (`ratio × pitch`), so the playhead sets the tempo and
//! the step sets the pitch. Hann windows at 50% overlap sum to one, so a steady
//! signal comes out unchanged.

use bm_dsp::sample_at;

pub struct Stretcher {
    hop: usize,
    window: Vec<f32>,
    tol: i64,
    /// Start (track frames) and read step of the grain fading out and the one
    /// fading in.
    prev: Option<(f64, f64)>,
    cur: Option<(f64, f64)>,
    /// Frames into the current hop.
    j: usize,
    /// The previous grain's continuation, mono, decimated by 2: what the next grain
    /// is matched against.
    natural: Vec<f32>,
    /// The samples around where the next grain should start, mono, at its step.
    region: Vec<f32>,
}

impl Stretcher {
    pub fn new(out_rate: f64) -> Self {
        let n = (((0.040 * out_rate) as usize) / 2) * 2;
        let hop = n / 2;
        let tol = (0.012 * out_rate) as i64;
        let m = ((0.010 * out_rate) as usize / 2).max(16);
        let window = (0..n)
            .map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos()) as f32)
            .collect();
        Self {
            hop,
            window,
            tol,
            prev: None,
            cur: None,
            j: 0,
            natural: vec![0.0; m],
            region: Vec::with_capacity(2 * tol as usize + 2 * m),
        }
    }

    /// Starts afresh at `pos`, as if a grain had been playing up to there, so the
    /// first output continues seamlessly from plain playback.
    pub fn reset(&mut self, pos: f64, step: f64) {
        self.prev = None;
        self.cur = Some((pos - self.hop as f64 * step, step));
        self.j = self.hop;
    }

    /// Makes the next frame start a new grain (after a jump), continuing from
    /// wherever the current grain is now.
    pub fn force_grain(&mut self) {
        if let Some((c, s)) = self.cur {
            self.cur = Some((c + (self.j as f64 - self.hop as f64) * s, s));
            self.j = self.hop;
        }
    }

    /// The next output frame. `pos`: where the deck is now (track frames);
    /// `step`: track frames per output frame to read grains at (pitch).
    #[inline]
    pub fn next(&mut self, left: &[f32], right: &[f32], pos: f64, step: f64) -> (f32, f32) {
        if self.j >= self.hop || self.cur.is_none() {
            self.j = 0;
            self.prev = self.cur;
            let start = match self.prev {
                Some((p, s)) => self.search(left, right, p + self.hop as f64 * s, pos, step),
                None => pos,
            };
            self.cur = Some((start, step));
        }
        let j = self.j;
        let (mut l, mut r) = (0.0, 0.0);
        if let Some((c, s)) = self.cur {
            let x = c + j as f64 * s;
            let w = self.window[j];
            l += sample_at(left, x) * w;
            r += sample_at(right, x) * w;
        }
        if let Some((p, s)) = self.prev {
            let x = p + (j + self.hop) as f64 * s;
            let w = self.window[j + self.hop];
            l += sample_at(left, x) * w;
            r += sample_at(right, x) * w;
        }
        self.j += 1;
        (l, r)
    }

    /// The start near `desired` whose waveform best continues `natural`.
    ///
    /// Both are first gathered (mono, at the grain's step) into buffers, so the
    /// search itself is plain index arithmetic: a coarse pass over every 8th offset
    /// comparing every 4th sample, then every offset near the best one.
    fn search(
        &mut self,
        left: &[f32],
        right: &[f32],
        natural: f64,
        desired: f64,
        step: f64,
    ) -> f64 {
        let len = left.len().min(right.len()) as i64;
        let at = |x: f64| -> f32 {
            let i = x as i64;
            if i >= 0 && i < len {
                0.5 * (left[i as usize] + right[i as usize])
            } else {
                0.0
            }
        };
        let m = self.natural.len();
        let mut energy = 0.0f32;
        for (k, v) in self.natural.iter_mut().enumerate() {
            *v = at(natural + (2 * k) as f64 * step + 0.5);
            energy += *v * *v;
        }
        if energy < 1e-9 {
            // Silence: nothing to line up with.
            return desired;
        }
        // region[i] is the sample at offset i - tol from `desired`.
        let tol = self.tol as usize;
        let span = 2 * tol + 2 * m;
        self.region.clear();
        let from = desired - self.tol as f64 * step + 0.5;
        self.region
            .extend((0..span).map(|i| at(from + i as f64 * step)));
        let region = &self.region;
        let natural = &self.natural;
        let score = |off: usize, stride: usize| -> f32 {
            let (mut dot, mut e) = (0.0f32, 1e-9f32);
            let mut k = 0;
            while k < m {
                let b = region[off + 2 * k];
                dot += natural[k] * b;
                e += b * b;
                k += stride;
            }
            dot / e.sqrt()
        };
        let mut best = (tol, f32::MIN);
        let mut off = 0;
        while off <= 2 * tol {
            let s = score(off, 4);
            if s > best.1 {
                best = (off, s);
            }
            off += 8;
        }
        let coarse = best.0;
        best.1 = f32::MIN;
        for off in coarse.saturating_sub(7)..=(coarse + 7).min(2 * tol) {
            let s = score(off, 1);
            if s > best.1 {
                best = (off, s);
            }
        }
        desired + (best.0 as f64 - self.tol as f64) * step
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    const SR: f64 = 48_000.0;

    fn sine(hz: f64, seconds: f64) -> Vec<f32> {
        (0..(seconds * SR) as usize)
            .map(|i| (0.5 * (TAU * hz * i as f64 / SR).sin()) as f32)
            .collect()
    }

    /// Frequency from zero crossings.
    fn freq(x: &[f32]) -> f64 {
        let crossings = x.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
        crossings as f64 / (x.len() as f64 / SR)
    }

    fn run(x: &[f32], speed: f64, pitch: f64, seconds: f64) -> (Vec<f32>, f64) {
        let mut s = Stretcher::new(SR);
        let mut pos = 1.0 * SR;
        s.reset(pos, pitch);
        let mut out = Vec::new();
        for _ in 0..(seconds * SR) as usize {
            out.push(s.next(x, x, pos, pitch).0);
            pos += speed;
        }
        (out, pos)
    }

    #[test]
    fn normal_speed_passes_audio_through() {
        let x = sine(440.0, 5.0);
        let (out, _) = run(&x, 1.0, 1.0, 2.0);
        let start = 48_000usize;
        let err: f32 = out
            .iter()
            .enumerate()
            .map(|(i, &y)| (y - x[start + i]).abs())
            .fold(0.0, f32::max);
        assert!(err < 0.02, "max error {err}");
    }

    #[test]
    fn faster_keeps_the_pitch() {
        let x = sine(440.0, 10.0);
        for speed in [0.92, 1.08] {
            let (out, pos) = run(&x, speed, 1.0, 3.0);
            let f = freq(&out[4800..]);
            assert!((f - 440.0).abs() < 4.0, "{f} Hz at speed {speed}");
            assert!((pos - (1.0 + 3.0 * speed) * SR).abs() < 1.0);
            // No dropouts: the level stays up.
            let rms =
                (out[4800..].iter().map(|v| v * v).sum::<f32>() / (out.len() - 4800) as f32).sqrt();
            assert!(rms > 0.3, "rms {rms}");
        }
    }

    #[test]
    fn key_shift_moves_the_pitch_not_the_tempo() {
        let x = sine(440.0, 10.0);
        let up = 2f64.powf(2.0 / 12.0);
        let (out, pos) = run(&x, 1.0, up, 3.0);
        let f = freq(&out[4800..]);
        assert!((f - 440.0 * up).abs() < 5.0, "{f} Hz");
        assert!((pos - 4.0 * SR).abs() < 1.0);
    }
}
