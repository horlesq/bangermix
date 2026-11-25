//! Audio decoding and tags, via Symphonia (pure Rust, so it runs in WebAssembly).
//! Decoding comes from double-drop (`dd-decode`, commit 9d3a720).

use std::io::Cursor;
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::{MetadataOptions, MetadataRevision, StandardTagKey, StandardVisualKey};
use symphonia::core::probe::{Hint, ProbeResult};

/// Decoded audio. In mono mode `right` is empty and `left` holds the mix of both.
pub struct Decoded {
    pub rate: u32,
    pub left: Vec<f32>,
    pub right: Vec<f32>,
}

#[derive(Default, Debug)]
pub struct Tags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub comment: Option<String>,
    pub year: Option<String>,
    pub bpm: Option<f64>,
    pub key: Option<String>,
    pub duration_s: Option<f64>,
    pub sample_rate: Option<u32>,
    /// Bits per sample, where the format says (lossless files).
    pub bits_per_sample: Option<u32>,
    /// Cover art: media type and bytes.
    pub art: Option<(String, Vec<u8>)>,
}

fn open(bytes: Vec<u8>, extension: Option<&str>) -> Result<ProbeResult, String> {
    let mut hint = Hint::new();
    if let Some(ext) = extension {
        hint.with_extension(ext);
    }
    let stream = MediaSourceStream::new(Box::new(Cursor::new(bytes)), Default::default());
    symphonia::default::get_probe()
        .format(
            &hint,
            stream,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| e.to_string())
}

/// Decodes a whole file held in memory; `extension` (e.g. `"mp3"`) helps detection.
pub fn decode(bytes: Vec<u8>, extension: Option<&str>, mono: bool) -> Result<Decoded, String> {
    let probed = open(bytes, extension)?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or("no audio track")?;
    let track_id = track.id;
    let mut rate = track.codec_params.sample_rate.unwrap_or(0);
    // Reserve the whole length up front when it is known, so the buffers never
    // double in size (and memory) while growing.
    let capacity = track.codec_params.n_frames.unwrap_or(0) as usize + 4096;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| e.to_string())?;

    let mut out = Decoded {
        rate,
        left: Vec::with_capacity(capacity),
        right: if mono {
            Vec::new()
        } else {
            Vec::with_capacity(capacity)
        },
    };
    let mut samples: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphoniaError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                break
            }
            Err(SymphoniaError::ResetRequired) => break,
            Err(e) => return Err(e.to_string()),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            // A damaged frame: skip it rather than give up on the track.
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(e) => return Err(e.to_string()),
        };
        let spec = *decoded.spec();
        rate = spec.rate;
        let channels = spec.channels.count().max(1);
        let buf = match &mut samples {
            Some(b) if b.capacity() >= decoded.capacity() * channels => b,
            _ => samples.insert(SampleBuffer::new(decoded.capacity() as u64, spec)),
        };
        buf.copy_interleaved_ref(decoded);
        for frame in buf.samples().chunks_exact(channels) {
            let l = frame[0];
            let r = if channels > 1 { frame[1] } else { frame[0] };
            if mono {
                out.left.push(0.5 * (l + r));
            } else {
                out.left.push(l);
                out.right.push(r);
            }
        }
    }
    if rate == 0 || out.left.is_empty() {
        return Err("no audio frames".into());
    }
    out.rate = rate;
    Ok(out)
}

/// Reads tags, length and cover art without decoding the audio.
pub fn probe(bytes: Vec<u8>, extension: Option<&str>) -> Result<Tags, String> {
    let mut probed = open(bytes, extension)?;
    let mut tags = Tags::default();
    if let Some(track) = probed
        .format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
    {
        let p = &track.codec_params;
        tags.sample_rate = p.sample_rate;
        tags.bits_per_sample = p.bits_per_sample;
        if let (Some(n), Some(sr)) = (p.n_frames, p.sample_rate) {
            tags.duration_s = Some(n as f64 / sr as f64);
        }
    }
    // Tags ahead of the container (ID3v2 on MP3), then the container's own.
    if let Some(meta) = probed.metadata.get() {
        if let Some(rev) = meta.current() {
            read_revision(rev, &mut tags);
        }
    }
    read_format_tags(probed.format.as_mut(), &mut tags);
    Ok(tags)
}

fn read_format_tags(format: &mut dyn FormatReader, tags: &mut Tags) {
    if let Some(rev) = format.metadata().current() {
        read_revision(rev, tags);
    }
}

fn read_revision(rev: &MetadataRevision, tags: &mut Tags) {
    for tag in rev.tags() {
        let value = tag.value.to_string().trim().to_string();
        if value.is_empty() {
            continue;
        }
        let slot = match tag.std_key {
            Some(StandardTagKey::TrackTitle) => &mut tags.title,
            Some(StandardTagKey::Artist) => &mut tags.artist,
            Some(StandardTagKey::Album) => &mut tags.album,
            Some(StandardTagKey::Genre) => &mut tags.genre,
            Some(StandardTagKey::Comment) => &mut tags.comment,
            Some(StandardTagKey::Date) | Some(StandardTagKey::OriginalDate) => &mut tags.year,
            Some(StandardTagKey::Bpm) => {
                if tags.bpm.is_none() {
                    tags.bpm = value
                        .replace(',', ".")
                        .parse::<f64>()
                        .ok()
                        .filter(|b| *b > 0.0);
                }
                continue;
            }
            _ => {
                let k = tag.key.to_ascii_uppercase();
                if k == "TKEY" || k == "INITIALKEY" || k == "KEY" || k.ends_with(":INITIALKEY") {
                    &mut tags.key
                } else {
                    continue;
                }
            }
        };
        if slot.is_none() {
            *slot = Some(value);
        }
    }
    if tags.art.is_none() {
        let visuals = rev.visuals();
        let best = visuals
            .iter()
            .find(|v| v.usage == Some(StandardVisualKey::FrontCover))
            .or_else(|| visuals.first());
        if let Some(v) = best {
            tags.art = Some((v.media_type.clone(), v.data.to_vec()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(channels: u16, rate: u32, frames: &[[i16; 2]]) -> Vec<u8> {
        let data_len = frames.len() as u32 * channels as u32 * 2;
        let mut v = Vec::new();
        v.extend_from_slice(b"RIFF");
        v.extend_from_slice(&(36 + data_len).to_le_bytes());
        v.extend_from_slice(b"WAVEfmt ");
        v.extend_from_slice(&16u32.to_le_bytes());
        v.extend_from_slice(&1u16.to_le_bytes());
        v.extend_from_slice(&channels.to_le_bytes());
        v.extend_from_slice(&rate.to_le_bytes());
        v.extend_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
        v.extend_from_slice(&(channels * 2).to_le_bytes());
        v.extend_from_slice(&16u16.to_le_bytes());
        v.extend_from_slice(b"data");
        v.extend_from_slice(&data_len.to_le_bytes());
        for f in frames {
            for &s in &f[..channels as usize] {
                v.extend_from_slice(&s.to_le_bytes());
            }
        }
        v
    }

    #[test]
    fn decodes_stereo_and_mono() {
        let frames: Vec<[i16; 2]> = (0..1000)
            .map(|i| [i as i16 * 10, -(i as i16) * 10])
            .collect();
        let a = decode(wav(2, 48_000, &frames), Some("wav"), false).unwrap();
        assert_eq!(a.rate, 48_000);
        assert_eq!(a.left.len(), 1000);
        assert!((a.right[500] + 5000.0 / 32768.0).abs() < 1e-6);
        let m = decode(wav(2, 48_000, &frames), Some("wav"), true).unwrap();
        assert!(m.right.is_empty());
        assert!(m.left[500].abs() < 1e-6);
        let t = probe(wav(2, 48_000, &frames), Some("wav")).unwrap();
        assert!((t.duration_s.unwrap() - 1000.0 / 48_000.0).abs() < 1e-9);
    }

    #[test]
    fn rejects_garbage() {
        assert!(decode(vec![1, 2, 3, 4, 5], Some("mp3"), false).is_err());
    }
}
