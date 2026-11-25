//! bangermix's waveform (peak, low, mid and high levels per column) turned into the
//! waveform types Pioneer players draw. The encodings follow Deep Symmetry's analysis
//! (djl-analysis.deepsymmetry.org, "Analysis Files"); the scales were set so that the
//! values land in the ranges rekordbox's own exports use (rekordcrate's demo export).

/// Level of one stretch of track, each 0 to 1.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Bands {
    pub peak: f32,
    pub low: f32,
    pub mid: f32,
    pub high: f32,
}

impl Bands {
    /// Overall loudness for column heights. The band levels are RMS × √2 (a full-scale
    /// sine reads 1), so mastered music sits around 0.3 to 0.5; this puts it at about
    /// two thirds of the height, as rekordbox draws it.
    pub fn level(&self) -> f32 {
        let rms = (self.low * self.low + self.mid * self.mid + self.high * self.high).sqrt();
        (rms * 1.6).clamp(0.0, 1.0)
    }

    fn strongest(&self) -> f32 {
        self.low.max(self.mid).max(self.high)
    }

    /// How much of the sound is highs: the "whiteness" of monochrome waveforms (0-7;
    /// rekordbox rarely goes above 5).
    fn whiteness(&self) -> u8 {
        let total = self.low + self.mid + self.high;
        if total <= 1e-6 {
            return 0;
        }
        ((self.high / total) * 10.0).round().clamp(0.0, 5.0) as u8
    }
}

/// bangermix's waveform: 4 bytes per column (peak, low, mid, high, each 0 to 255).
pub struct Columns<'a> {
    data: &'a [u8],
    per_s: f64,
}

impl<'a> Columns<'a> {
    pub fn new(data: &'a [u8], columns_per_s: f64) -> Self {
        Self {
            data,
            per_s: columns_per_s.max(1.0),
        }
    }

    fn count(&self) -> usize {
        self.data.len() / 4
    }

    /// The loudest peak and the RMS of each band between `t0` and `t1` seconds.
    pub fn span(&self, t0: f64, t1: f64) -> Bands {
        let n = self.count();
        if n == 0 {
            return Bands::default();
        }
        let a = ((t0 * self.per_s).floor().max(0.0) as usize).min(n - 1);
        let b = ((t1 * self.per_s).ceil() as usize).clamp(a + 1, n);
        let (mut peak, mut sums) = (0u8, [0f32; 3]);
        for c in self.data[a * 4..b * 4].as_chunks::<4>().0 {
            peak = peak.max(c[0]);
            for k in 0..3 {
                let v = c[k + 1] as f32 / 255.0;
                sums[k] += v * v;
            }
        }
        let count = (b - a) as f32;
        let [low, mid, high] = sums.map(|s| (s / count).sqrt());
        Bands {
            peak: peak as f32 / 255.0,
            low,
            mid,
            high,
        }
    }
}

/// `count` equal stretches over `duration` seconds.
pub fn evenly(columns: &Columns<'_>, duration: f64, count: usize) -> Vec<Bands> {
    let step = duration.max(0.0) / count as f64;
    (0..count)
        .map(|i| columns.span(i as f64 * step, (i + 1) as f64 * step))
        .collect()
}

/// The 150-per-second stretches of the scrolling waveforms ("half frames").
pub fn detail(columns: &Columns<'_>, duration: f64) -> Vec<Bands> {
    let count = (duration.max(0.0) * 150.0).ceil() as usize;
    (0..count)
        .map(|i| columns.span(i as f64 / 150.0, (i + 1) as f64 / 150.0))
        .collect()
}

fn scale(v: f32, max: f32) -> u8 {
    (v * max).round().clamp(0.0, max) as u8
}

/// PWAV and PWV3: five bits of height, three of whiteness.
pub fn mono(b: &Bands) -> u8 {
    scale(b.level(), 31.0) | (b.whiteness() << 5)
}

/// PWV2: four bits of height.
pub fn tiny(b: &Bands) -> u8 {
    scale(b.level(), 15.0)
}

/// PWV5: three bits each of red (lows), green (mids) and blue (highs), five of height,
/// two unused. Big-endian.
pub fn color_detail(b: &Bands) -> [u8; 2] {
    let strongest = b.strongest().max(1e-6);
    let rgb = |v: f32| scale(v / strongest, 7.0) as u16;
    let height = scale(b.level(), 31.0) as u16;
    let v = (rgb(b.low) << 13) | (rgb(b.mid) << 10) | (rgb(b.high) << 7) | (height << 2);
    v.to_be_bytes()
}

/// PWV4: six bytes. Bytes 2-5 are the energy of the whole lower half, the lows, the mids
/// and the highs; bytes 0-1 are not understood, and are made to move the way
/// rekordbox's do (byte 0 with loudness, byte 1 against it).
pub fn color_preview(b: &Bands) -> [u8; 6] {
    let level = b.level();
    let whole = scale(level, 127.0);
    [
        scale(level * 0.85, 127.0),
        255 - scale(level, 120.0),
        whole,
        scale(b.low * 1.4, 127.0),
        scale(b.mid * 1.4, 127.0),
        scale(b.high * 1.8, 127.0),
    ]
}

/// PWV6 (preview) and PWV7 (detail): one byte each for mids, highs and lows, in that
/// order. rekordbox's previews peak around 40, its details at 127.
pub fn three_band(b: &Bands, max: f32, gain: f32) -> [u8; 3] {
    [
        scale(b.mid * gain, max),
        scale(b.high * gain, max),
        scale(b.low * gain, max),
    ]
}

/// PWVC: per-band gains for drawing the 3-band waveform, low, mid, high. rekordbox
/// computes them per track, larger for quieter bands; these follow its ratios.
pub fn three_band_gains(preview: &[[u8; 3]]) -> [u16; 3] {
    let max = |k: usize| preview.iter().map(|c| c[k]).max().unwrap_or(0).max(1) as f32;
    let gain = |target: f32, m: f32| (target / m).round().clamp(1.0, 2000.0) as u16;
    [
        gain(3800.0, max(2)),
        gain(7500.0, max(0)),
        gain(14500.0, max(1)),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_average_power_and_keep_peaks() {
        // Two columns per second: a loud one, then silence.
        let data = [255, 255, 0, 0, 0, 0, 0, 0];
        let c = Columns::new(&data, 2.0);
        let b = c.span(0.0, 1.0);
        assert_eq!(b.peak, 1.0);
        assert!((b.low - (0.5f32).sqrt()).abs() < 1e-6);
        assert_eq!(c.span(0.5, 1.0).low, 0.0);
    }

    #[test]
    fn color_detail_packs_bits_as_documented() {
        let b = Bands {
            peak: 1.0,
            low: 1.0,
            mid: 0.0,
            high: 0.0,
        };
        let v = u16::from_be_bytes(color_detail(&b));
        assert_eq!(v >> 13, 7, "red holds the lows");
        assert_eq!((v >> 10) & 7, 0);
        assert_eq!((v >> 7) & 7, 0);
        assert_eq!((v >> 2) & 31, 31, "a full-scale low fills the height");
    }

    #[test]
    fn silence_is_flat_and_dark() {
        let b = Bands::default();
        assert_eq!(mono(&b), 0);
        assert_eq!(tiny(&b), 0);
        assert_eq!(color_preview(&b)[1], 255);
    }
}
