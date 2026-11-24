//! The engine as a WebAssembly module for the AudioWorklet.
//!
//! Plain `extern "C"` exports over numbers and pointers into the module's memory:
//! the worklet scope has no `TextDecoder` and the like that wasm-bindgen glue expects,
//! and the hot path must not allocate. The worklet (`web/public/worklet.js`) calls:
//!
//! - `bm_init(sample_rate)` once;
//! - `bm_set(deck, param, value)` for every control change;
//! - `bm_process(frames)` per block, then reads the four output channels at
//!   `bm_out_ptr()` (master L, master R, phones L, phones R, each `MAX_BLOCK` long)
//!   and the state snapshot at `bm_state_ptr()`;
//! - `bm_load_begin`, then `bm_load_push` after filling the staging area at
//!   `bm_staging_ptr()` (left, then right, `bm_staging_frames()` each), to load a track
//!   a chunk per block.

use bm_engine::{Engine, MAX_BLOCK, STATE_LEN};
use std::cell::UnsafeCell;

const STAGING_FRAMES: usize = 1 << 16;

struct Global {
    engine: Engine,
    out: Vec<f32>,
    staging: Vec<f32>,
}

/// WebAssembly here is single-threaded: one global, reached only from the worklet.
struct Slot(UnsafeCell<Option<Box<Global>>>);
unsafe impl Sync for Slot {}
static GLOBAL: Slot = Slot(UnsafeCell::new(None));

#[allow(clippy::mut_from_ref)]
fn global() -> &'static mut Global {
    // SAFETY: single-threaded, and no export holds the reference across calls.
    unsafe { (*GLOBAL.0.get()).as_mut().expect("bm_init first") }
}

#[no_mangle]
pub extern "C" fn bm_init(sample_rate: f64) {
    let g = Global {
        engine: Engine::new(sample_rate),
        out: vec![0.0; MAX_BLOCK * 4],
        staging: vec![0.0; STAGING_FRAMES * 2],
    };
    unsafe { *GLOBAL.0.get() = Some(Box::new(g)) };
}

#[no_mangle]
pub extern "C" fn bm_max_block() -> u32 {
    MAX_BLOCK as u32
}

#[no_mangle]
pub extern "C" fn bm_out_ptr() -> *mut f32 {
    global().out.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn bm_process(frames: u32) {
    let g = global();
    let n = (frames as usize).min(MAX_BLOCK);
    let (master, phones) = g.out.split_at_mut(MAX_BLOCK * 2);
    let (ml, mr) = master.split_at_mut(MAX_BLOCK);
    let (pl, pr) = phones.split_at_mut(MAX_BLOCK);
    g.engine
        .render([&mut ml[..n], &mut mr[..n]], [&mut pl[..n], &mut pr[..n]]);
}

#[no_mangle]
pub extern "C" fn bm_state_ptr() -> *const f64 {
    global().engine.state.as_ptr()
}

#[no_mangle]
pub extern "C" fn bm_state_len() -> u32 {
    STATE_LEN as u32
}

#[no_mangle]
pub extern "C" fn bm_set(deck: u32, param: u32, value: f64) {
    global().engine.set(deck, param, value);
}

#[no_mangle]
pub extern "C" fn bm_load_begin(deck: u32, frames: u32, rate: f64) {
    global().engine.load_begin(deck, frames as usize, rate);
}

#[no_mangle]
pub extern "C" fn bm_staging_ptr() -> *mut f32 {
    global().staging.as_mut_ptr()
}

#[no_mangle]
pub extern "C" fn bm_staging_frames() -> u32 {
    STAGING_FRAMES as u32
}

#[no_mangle]
pub extern "C" fn bm_load_push(deck: u32, frames: u32) {
    let g = global();
    let n = (frames as usize).min(STAGING_FRAMES);
    let (l, r) = g.staging.split_at(STAGING_FRAMES);
    g.engine.load_push(deck, &l[..n], &r[..n]);
}

#[no_mangle]
pub extern "C" fn bm_unload(deck: u32) {
    global().engine.unload(deck);
}
