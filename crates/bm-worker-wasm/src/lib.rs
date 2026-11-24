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
            "duration": t.duration_s, "sampleRate": t.sample_rate, "artType": art_type,
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
