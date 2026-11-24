# bangermix: plan

A DJ app that runs in the browser, laid out like a classic performance screen: decks with scrolling waveforms on top, the mixer between them, the library browser below. It is played with a mouse and keyboard or a MIDI controller. Everything runs on the client, with no server beyond static hosting.

- **Name:** bangermix, at **bangermix.horly.dev**
- **For:** the owner, on Chrome on Windows. Other browsers work where they can.
- **Status (24 November 2026):** phases 0–6, 8 and most of 9 built, and tested in headless Chrome with generated tracks. Keylock (phase 7), a real-hardware test and the first deploy are next.

## Decided
| | Decision |
|---|---|
| Hosting | Static files on Cloudflare Pages, with COOP/COEP headers for `SharedArrayBuffer` (`web/public/_headers`). Deployed from CI. |
| Browser | Chrome is the target. Firefox and Safari: drop files in each visit, no MIDI, no output choice. |
| Decks | 2 by default, 4 as an option (top bar). |
| Input | Mouse and keyboard fully; MIDI controllers through presets and MIDI learn. |
| Files | MP3, WAV, FLAC, AIFF, M4A/AAC, Ogg. Pick a folder, or drop files and folders. |
| Library import | Later (Rekordbox XML first). |
| Look | A familiar layout with its own identity: violet / hot pink / ice waveforms, its own colours and logo, no third-party branding. |

## Stack as built
| Layer | Choice |
|---|---|
| Audio engine | Rust → WebAssembly in an AudioWorklet (`bm-engine`, `bm-engine-wasm`, `web/public/worklet.js`) |
| Decoding | Symphonia (Rust) in workers (`bm-decode`) |
| Analysis | Rust in a pool of workers (`bm-analysis`): BPM, grid, downbeat, key, loudness, 3-band waveform |
| UI | TypeScript + SolidJS 1.9 + Vite |
| Hot visuals | Canvas 2D: each waveform is painted once into tiles, and each frame only copies the visible part |
| Library | IndexedDB, with sorting and filtering in memory |
| File access | File System Access API, with folder handles kept in IndexedDB; fallback to drop / file input |
| Controllers | Web MIDI with SysEx (the DDJ-FLX4 needs a keep-alive) |

### Changes from the first plan, and why
- **No wasm-bindgen anywhere.** Both modules use plain `extern "C"` exports with zero imports. The worklet needs that anyway, and it removes a build tool.
- **IndexedDB, not SQLite.** A few thousand tracks sort and filter in memory in milliseconds, and it saves a 1 MB dependency. SQLite can come back if smart playlists need real queries.
- **Canvas 2D tiles, not WebGL.** Painting a track once and copying is cheap enough at 60 fps with four decks. WebGL stays an option if profiling says so.
- **Commands go by `postMessage`, state comes back by shared memory.** Commands are batched per task. Latency is under one audio block, which is fine for MIDI.
- **SolidJS 1.9, not 2.0.** The Vite plugin doesn't support 2.0 yet.

## What came from double-drop
Copied (not linked), with the source commit `9d3a720` noted in each file:
- Symphonia decoding.
- Biquads, the 3-band Linkwitz-Riley isolator, the DJ filter, the look-ahead limiter and cubic interpolation.
- The echo's feedback tone.
- The waveform builder.
- Spectral-flux features, tempo by onset folding, downbeats and moving the grid onto attacks.
- Krumhansl key estimation.

Changes for general DJing:
- The tempo range comes from settings (88–175 by default).
- Grids snap to whole or half BPMs when that fits as well.
- The key profiles are the textbook ones rather than double-drop's drum-and-bass ones.
- Drop detection and the set planner were not taken. Later, double-drop's planner could become an auto-mix mode here.

## Engine (bm-engine)
- **Decks:** play, pause and seek, with 3–4 ms fades and crossfades so nothing clicks. Varispeed tempo plus bend, scratching with a smoothed platter speed, reverse, loops (sample-accurate, crossfaded wrap), slip (a ghost position and a return to it), and sync.
- **Sync:** the master deck's tempo and beat phase are read once per block. A synced deck matches the tempo (or half or double), jumps into phase when sync is pressed or play starts, and then holds phase with at most ±1% correction.
- **Mixer:** trim, isolator EQ (kill to +6 dB), colour filter, fader × crossfader, and pre-fader cue. Master gain then the limiter. Headphones get a cue/master blend. Meters fall at about 30 dB/s.
- **Beat FX:** echo (rings out when switched off), reverb, flanger and roll, on any channel or the master, synced to the master BPM.
- **Loading:** a track is copied into the worklet 64k frames per audio block, so a 6-minute track loads in under a second without dropouts.

## Build order
0. ✅ Scaffold: Cargo workspace, Vite/Solid app, wasm build script, CI.
1. ✅ Engine: decks, mixer, sync, loops, slip, scratch. 11 engine tests.
2. ✅ Deck and layout: waveforms, overview, jog wheel, tempo fader, transport, keyboard shortcuts.
3. ✅ Analysis in a worker pool, sync, quantize, grid edits (shift, downbeat here, BPM ±, half/double).
4. ✅ Library: folders, drop-in, tags and cover art, background analysis, playlists, search, sort, key/BPM matches against the master deck.
5. ✅ Mixer and headphone cue: 4-output, split mono, and output device choice.
6. ✅ Hot cues (8, with colours, saved loops), memory cues, auto loops, loop in/out, halve/double, beat jump.
7. ⬜ **Keylock (master tempo).** A time-stretcher in Rust: port Signalsmith Stretch's design (MIT) or write a phase-locked vocoder.
8. ✅ Controllers: Web MIDI, a DDJ-FLX4 preset (from the Mixxx mapping: pads in hot cue, beat loop, beat jump and pad FX modes, jogs, LEDs, VU, keep-alive), and MIDI learn. ⚠ Not yet tried on hardware.
9. 🟨 FX, recording and 4 decks are done. Still to do: an offline service worker (PWA) and auto gain tuned to real tracks.

## Next
1. Deploy: connect the repo to GitHub, add the Cloudflare secrets, and point `bangermix.horly.dev` at the Pages project.
2. Test with the owner's music and DDJ-FLX4: tempo fader direction, jog feel (scratch and bend scaling) and LED states.
3. Keylock.
4. A second output device for headphones (a second `AudioContext` and drift correction) for laptops without a 4-channel interface.
5. Rekordbox XML import (cues, grids, playlists).
6. Later: stems on WebGPU, auto-mix from double-drop, and a Tauri desktop build with native audio.
