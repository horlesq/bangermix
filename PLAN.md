# bangermix: plan

A DJ app that runs in the browser, laid out like a classic performance screen: decks with scrolling waveforms on top, the mixer between them, the library browser below. It is played with a mouse and keyboard or a MIDI controller. Everything runs on the client, with no server beyond static hosting.

- **Name:** bangermix, at **bangermix.horly.dev**
- **For:** the owner, on Chrome on Windows. Other browsers work where they can.
- **Status (25 November 2026):** every phase built, plus headphones on a second device, rekordbox XML import, offline use, a redesigned interface and about 50 controllers through Mixxx's mappings. Deployed at bangermix.horly.dev. Tested in headless Chrome with generated tracks and simulated controller messages; not yet on hardware.

## Decided
| | Decision |
|---|---|
| Hosting | Static files on Cloudflare Pages, with COOP/COEP headers for `SharedArrayBuffer` (`web/public/_headers`). Deployed from CI. |
| Browser | Chrome is the target. Firefox and Safari: drop files in each visit, no MIDI, no output choice. |
| Decks | 2 by default, 4 as an option (top bar). |
| Input | Mouse and keyboard fully; MIDI controllers through presets and MIDI learn. |
| Files | MP3, WAV, FLAC, AIFF, M4A/AAC, Ogg. Pick a folder, or drop files and folders. |
| Library import | Later (Rekordbox XML first). |
| Look | The layout DJs know from the big DJ apps, in its own visual style: neutral greys, flat hardware-like controls, colour only where it means something (green play, orange cue, blue sync, amber master), RGB waveforms (lows red, mids green, highs blue), no third-party branding. |

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
| Controllers | Web MIDI with SysEx (the DDJ-FLX4 needs a keep-alive); WebHID for Traktor Kontrol and CDJs in HID mode. Every controller runs the Mixxx project's mapping (`src/midi/mixxx`) |
| Keylock | WSOLA time-stretch in the engine (`stretch.rs`); key shift from the same grains |
| Headphones on a second device | A second AudioContext on that device, fed through a shared-memory ring; its reader resamples by up to ±0.3% to follow the clock drift |
| Offline | A service worker (`web/public/sw.js`): hashed assets cache-first, everything else network-first |

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
- **Sync:** the master deck's tempo and bar position are read once per block. A synced deck matches the tempo (or half or double). When sync engages or play starts it jumps so its bars line up with the master's (downbeats together; a setting reduces this to beats). It then holds the beat with at most ±1% correction. After any jump it lands back on the beat at once: an overview click also realigns the bar, while beat jumps and hot cues keep their place in it. The waveforms are drawn at the tempo each deck plays at, so synced grids line up across the screen.
- **Mixer:** trim, isolator EQ (kill to +6 dB), colour filter, fader × crossfader, and pre-fader cue. Master gain then the limiter. Headphones get a cue/master blend. Meters fall at about 30 dB/s.
- **Beat FX:** echo (rings out when switched off), reverb, flanger and roll, on any channel or the master, synced to the master BPM.
- **Loading:** a track is copied into the worklet 64k frames per audio block, so a 6-minute track loads in under a second without dropouts.
- **Keylock and key shift:** WSOLA, the method SoundTouch (and Mixxx's default keylock) uses. The track is all in memory, so grains are read straight from it: every 20 ms a new 40 ms grain starts where the deck is, nudged by up to 12 ms to where its waveform best continues the last one, and is read at its own step (the pitch). Jumps and loop wraps crossfade through the grains. Four keylocked decks cost 1.8% of a core natively (plain playback: 1%).

## Build order
0. ✅ Scaffold: Cargo workspace, Vite/Solid app, wasm build script, CI.
1. ✅ Engine: decks, mixer, sync, loops, slip, scratch. 11 engine tests.
2. ✅ Deck and layout: waveforms, overview, jog wheel, tempo fader, transport, keyboard shortcuts.
3. ✅ Analysis in a worker pool, sync, quantize, grid edits (shift, downbeat here, BPM ±, half/double).
4. ✅ Library: folders, drop-in, tags and cover art, background analysis, playlists, search, sort, key/BPM matches against the master deck.
5. ✅ Mixer and headphone cue: 4-output, split mono, and output device choice.
6. ✅ Hot cues (8, with colours, saved loops), memory cues, auto loops, loop in/out, halve/double, beat jump.
7. ✅ Keylock (MT), key shift ±12 and key sync (shifts a deck into the master's key); the key readout shows the key as heard.
8. ✅ Controllers: Web MIDI, a DDJ-FLX4 preset (from the Mixxx mapping: pads in hot cue, beat loop, beat jump and pad FX modes, jogs, LEDs, VU, keep-alive), and MIDI learn. Replaced in step 13 by Mixxx's own mappings; MIDI learn stays.
9. ✅ FX, recording, 4 decks, offline service worker. Auto gain still needs tuning on real tracks.
10. ✅ Headphones on a second output device (Settings → Audio).
11. ✅ rekordbox XML import: grids, keys, hot cues (with colours and names), memory cues, saved loops, ratings, play counts, playlists (folders flattened to "Folder / Playlist"). Tracks match by file name and size.
12. ✅ Interface redesign: pad modes (hot cue / beat loop / beat jump), readouts for key, BPM, time and tempo, status flags, platter with a progress ring, RGB or 3-band waveforms, icons.
13. ✅ Controllers from Mixxx: Pioneer (DDJ-FLX4, -400, -200, -SB, -SB2, -SB3, -SX, CDJ-2000/850/350, CDJ HID), Native Instruments (Traktor Kontrol S4 MK3/MK2, S3, S2 MK3/MK2/MK1, MX2, Z1, F1, X1), Numark (Mixtrack Platinum FX, Pro FX, Platinum, Pro 3, Pro II, Pro, Mixtrack, Mixstream Pro, NS4FX, NS6II, NS7, N4, V7, Party Mix, DJ2GO2 Touch, DJ2Go, iDJ Live II, Omni Control, Total Control, Scratch), Denon DJ (MC7000, MC6000MK2, MC4000, MC3000, SC2000, HS5500). Mappings are fetched from Mixxx 2.5.6 and cached. A compatibility layer gives their scripts Mixxx's engine API (values, parameters, connections, timers, soft takeover, scratching with Mixxx's alpha-beta filter, brake and spinback) and applies their XML the way Mixxx does (MIDI options, 14-bit, outputs). All 48 load and start; with every input pressed in turn, 39 run without a script error, and the rest fail on bugs in the mappings themselves or on fake test input. ⚠ Untested on hardware.

## Next
1. Test with the owner's music and controllers: on Mixxx-mapped ones, that the mapping loads, jogs scratch at the right speed, LEDs follow, and Traktor HID controllers connect; then tempo fader direction, LED states and the second-device headphones (drift over a long set).
2. Listen to keylock on real music at ±8%; if it smears, try longer grains or a phase vocoder for tonal material.
3. Controller options: Mixxx mappings declare settings (jog sensitivity, pad modes); they run on their defaults until there is a screen for them.
4. Later: Traktor NML and Serato imports, stems on WebGPU, auto-mix from double-drop, a Tauri desktop build with native audio.
