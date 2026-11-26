//! Decoding, tags and analysis as a WebAssembly module for Web Workers.
//!
//! Plain `extern "C"` exports, driven by `web/src/workers/wasm.ts`:
//!
//! 1. `wk_input(len)` returns where to write the file's bytes, `wk_ext()` where to
//!    write its extension (up to 15 bytes);
//! 2. `wk_decode(ext_len, mono)` or `wk_probe(ext_len)` consume them;
//! 3. after a decode, `wk_pcm(channel)` and `wk_pcm_frames()` give the audio, and
//!    `wk_analyse(min_bpm, max_bpm, columns_per_s)` analyses it;
//! 4. results are JSON at `wk_json()`/`wk_json_len()`, plus bytes (waveform or cover
//!    art) at `wk_bytes()`/`wk_bytes_len()`.
//!
//! 5. for exports, `wk_input` holds a little-endian u32 JSON length, the JSON, then any
//!    binary data; `wk_export_pioneer_db()` and `wk_export_pioneer_track(columns_per_s)`
//!    leave a bundle of files (`bm_export::bundle`) at `wk_bytes()`.
//! 6. for imports, `wk_input` holds a bundle of a USB stick's files;
//!    `wk_read_pioneer_db()` and `wk_read_pioneer_analysis()` leave JSON.
//!
//! Each call returns 0 on success; on failure the JSON is `{"error": ...}`.

use bm_analysis::TempoRange;
use bm_decode::Decoded;
use serde_json::json;
use std::cell::UnsafeCell;

#[derive(Default)]
struct State {
    input: Vec<u8>,
    ext: [u8; 16],
    pcm: Option<Decoded>,
    json: String,
    bytes: Vec<u8>,
}

struct Slot(UnsafeCell<Option<Box<State>>>);
unsafe impl Sync for Slot {}
static STATE: Slot = Slot(UnsafeCell::new(None));

#[allow(clippy::mut_from_ref)]
fn state() -> &'static mut State {
    // SAFETY: a worker is single-threaded, and no export holds this across calls.
    unsafe { (*STATE.0.get()).get_or_insert_with(Default::default) }
}

fn finish(result: Result<serde_json::Value, String>) -> i32 {
    let s = state();
    match result {
        Ok(v) => {
            s.json = v.to_string();
            0
        }
        Err(e) => {
            s.json = json!({ "error": e }).to_string();
            s.bytes.clear();
            1
        }
    }
}

fn extension(len: u32) -> Option<String> {
    let s = state();
    let len = (len as usize).min(s.ext.len());
    std::str::from_utf8(&s.ext[..len])
        .ok()
        .filter(|e| !e.is_empty())
        .map(str::to_owned)
}

#[no_mangle]
pub extern "C" fn wk_input(len: u32) -> *mut u8 {
    let s = state();
    s.input = vec![0; len as usize];
    s.input.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn wk_ext() -> *mut u8 {
    state().ext.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn wk_decode(ext_len: u32, mono: u32) -> i32 {
    let ext = extension(ext_len);
    let s = state();
    let bytes = std::mem::take(&mut s.input);
    s.pcm = None;
    s.bytes.clear();
    let result = bm_decode::decode(bytes, ext.as_deref(), mono != 0).map(|d| {
        let v = json!({ "rate": d.rate, "frames": d.left.len(), "stereo": !d.right.is_empty() });
        state().pcm = Some(d);
        v
    });
    finish(result)
}

#[no_mangle]
pub extern "C" fn wk_pcm(channel: u32) -> *const f32 {
    match &state().pcm {
        Some(d) if channel == 1 && !d.right.is_empty() => d.right.as_ptr(),
        Some(d) => d.left.as_ptr(),
        None => std::ptr::null(),
    }
}

#[no_mangle]
pub extern "C" fn wk_pcm_frames() -> u32 {
    state().pcm.as_ref().map_or(0, |d| d.left.len() as u32)
}

#[no_mangle]
pub extern "C" fn wk_free_pcm() {
    state().pcm = None;
}

#[no_mangle]
pub extern "C" fn wk_analyse(min_bpm: f64, max_bpm: f64, columns_per_s: f64) -> i32 {
    let s = state();
    let Some(d) = &s.pcm else {
        return finish(Err("nothing decoded".into()));
    };
    let mono: std::borrow::Cow<[f32]> = if d.right.is_empty() {
        (&d.left[..]).into()
    } else {
        d.left
            .iter()
            .zip(&d.right)
            .map(|(l, r)| 0.5 * (l + r))
            .collect::<Vec<_>>()
            .into()
    };
    let a = bm_analysis::analyse(&mono, d.rate, TempoRange { min_bpm, max_bpm });
    let w = bm_analysis::waveform::build(&mono, d.rate, columns_per_s);
    drop(mono);
    s.bytes = w.data;
    let key = a
        .key
        .map(|k| json!({ "tonic": k.tonic, "minor": k.minor, "confidence": k.confidence }));
    finish(Ok(json!({
        "duration": a.duration_s,
        "bpm": a.bpm,
        "anchor": a.anchor_s,
        "gridConfidence": a.grid_confidence,
        "downbeatConfidence": a.downbeat_confidence,
        "key": key,
        "loudness": a.loudness_db,
        "columnsPerS": w.columns_per_s,
    })))
}

#[no_mangle]
pub extern "C" fn wk_probe(ext_len: u32) -> i32 {
    let ext = extension(ext_len);
    let s = state();
    let bytes = std::mem::take(&mut s.input);
    s.bytes.clear();
    let result = bm_decode::probe(bytes, ext.as_deref()).map(|t| {
        let art_type = t.art.as_ref().map(|(m, _)| m.clone());
        if let Some((_, data)) = t.art {
            state().bytes = data;
        }
        json!({
            "title": t.title, "artist": t.artist, "album": t.album, "genre": t.genre,
            "comment": t.comment, "year": t.year, "bpm": t.bpm, "key": t.key,
            "duration": t.duration_s, "sampleRate": t.sample_rate, "bitDepth": t.bits_per_sample,
            "artType": art_type,
        })
    });
    finish(result)
}

#[no_mangle]
pub extern "C" fn wk_json() -> *const u8 {
    state().json.as_ptr()
}

#[no_mangle]
pub extern "C" fn wk_json_len() -> u32 {
    state().json.len() as u32
}

#[no_mangle]
pub extern "C" fn wk_bytes() -> *const u8 {
    state().bytes.as_ptr()
}

#[no_mangle]
pub extern "C" fn wk_bytes_len() -> u32 {
    state().bytes.len() as u32
}

/// Splits the input into its JSON and the binary data after it.
fn json_and_data(input: &[u8]) -> Result<(&str, &[u8]), String> {
    let n = input
        .get(..4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
        .ok_or("no input")?;
    let json = input.get(4..4 + n).ok_or("input shorter than its JSON")?;
    let json = std::str::from_utf8(json).map_err(|e| e.to_string())?;
    Ok((json, &input[4 + n..]))
}

/// The Pioneer device library (export.pdb and setting files) for a
/// `bm_export::model::Library` given as JSON.
#[no_mangle]
pub extern "C" fn wk_export_pioneer_db() -> i32 {
    let s = state();
    let input = std::mem::take(&mut s.input);
    s.bytes.clear();
    let result = json_and_data(&input).and_then(|(json, _)| {
        let library: bm_export::model::Library =
            serde_json::from_str(json).map_err(|e| e.to_string())?;
        let files = bm_export::pioneer::database(&library)?;
        state().bytes = bm_export::bundle(&files);
        Ok(json!({ "files": files.len() }))
    });
    finish(result)
}

/// One track's Pioneer analysis files, for a `bm_export::model::Track` as JSON followed
/// by its waveform.
#[no_mangle]
pub extern "C" fn wk_export_pioneer_track(columns_per_s: f64) -> i32 {
    let s = state();
    let input = std::mem::take(&mut s.input);
    s.bytes.clear();
    let result = json_and_data(&input).and_then(|(json, waveform)| {
        let track: bm_export::model::Track =
            serde_json::from_str(json).map_err(|e| e.to_string())?;
        let files = bm_export::pioneer::track_files(&track, waveform, columns_per_s);
        state().bytes = bm_export::bundle(&files);
        Ok(json!({ "files": files.len() }))
    });
    finish(result)
}

/// Reads a rekordbox USB stick's library: the input is a bundle (`bm_export::bundle`) of
/// `export.pdb` and, if the stick has one, `exportExt.pdb`. The JSON is
/// `bm_export::read::StickLibrary`.
#[no_mangle]
pub extern "C" fn wk_read_pioneer_db() -> i32 {
    let s = state();
    let input = std::mem::take(&mut s.input);
    s.bytes.clear();
    let result = (|| {
        let files = bm_export::unbundle(&input).ok_or("bad input bundle")?;
        let mut pdb = None;
        let mut ext = None;
        for (path, bytes) in files {
            match path.as_str() {
                "export.pdb" => pdb = Some(bytes),
                "exportExt.pdb" => ext = Some(bytes),
                _ => {}
            }
        }
        let library = bm_export::read::read_device(pdb.ok_or("no export.pdb")?, ext)?;
        serde_json::to_value(library).map_err(|e| e.to_string())
    })();
    finish(result)
}

/// Reads a track's grid and cues from its analysis files: the input is a bundle of
/// `DAT` and, if there is one, `EXT`. The JSON is `bm_export::read::StickAnalysis`.
#[no_mangle]
pub extern "C" fn wk_read_pioneer_analysis() -> i32 {
    let s = state();
    let input = std::mem::take(&mut s.input);
    s.bytes.clear();
    let result = (|| {
        let files = bm_export::unbundle(&input).ok_or("bad input bundle")?;
        let get = |name: &str| {
            files
                .iter()
                .find(|(p, _)| p == name)
                .map(|(_, b)| b.as_slice())
        };
        let analysis = bm_export::read::read_analysis(get("DAT").ok_or("no DAT file")?, get("EXT"));
        serde_json::to_value(analysis).map_err(|e| e.to_string())
    })();
    finish(result)
}
