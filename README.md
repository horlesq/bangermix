# bangermix

A DJ app in the browser, laid out like the classic two-deck performance screen: scrolling 3-band waveforms on top, decks either side of a mixer, the library below. Everything runs on your computer: audio, analysis and the library. Nothing is uploaded. It goes online at **bangermix.horly.dev** as static files.

**Status (24 November 2026):** first working version. Two or four decks, sync, loops, hot cues, beat FX, recording, a library from your music folder, keyboard and mouse control, and a mapping for the Pioneer DDJ-FLX4. Tested in Chrome with generated tracks; not yet with a real controller or a large library. See [PLAN.md](PLAN.md) for what comes next.

## Run it
Needs Rust (stable, with `rustup target add wasm32-unknown-unknown`) and Node.js 22+. On Windows, run the commands from PowerShell.
From the repository root (or from `web/`, same commands):
```sh
npm install        # installs the web app's packages (in web/)
npm run dev        # builds the WebAssembly, then serves http://localhost:5173
npm run build      # production build in web/dist
npm run preview    # serve the build
```
Rust tests: `cargo test --workspace` from the repository root.

Use Chrome or Edge. Other browsers play too, but they don't remember your music folder between visits (drop the files in again) and don't support MIDI or choosing the output device.

## Using it
- **Music:** *Add a music folder* (Chrome remembers it; after a restart it asks for one click to read it again), or drop files and folders anywhere on the window. Tracks are analysed in the background: BPM, beat grid, key, waveform.
- **Load:** double-click a track, drag it onto a deck, or select it and press `E` (deck 1) / `I` (deck 2).
- **Mouse:** knobs and faders drag, double-click resets, Shift for fine moves. Drag a waveform or jog wheel to scratch (or nudge with *Vinyl* off). Scroll a waveform to zoom.
- **Keyboard:** `F1` lists every shortcut. Deck 1 is on the left hand (`Z` cue, `X` play, `C` sync, `1–4` hot cues), deck 2 on the right (`M` cue, `,` play, `.` sync, `7–0` hot cues).
- **Headphone cue:** Settings → Audio. A controller's 4-output sound card puts the headphones on outputs 3–4. With a plain stereo output, *split* puts the master in mono on the left and the headphones on the right (for a splitter cable).
- **Controllers:** Settings → MIDI → *Connect*. The DDJ-FLX4 is mapped (from the Mixxx project's open mapping). Anything else: MIDI learn, one control at a time.
- **Recording:** ● REC records the master and saves a `.webm` file when stopped.

## How it is built
```
crates/
  bm-dsp          filters, 3-band isolator EQ, DJ filter, limiter, interpolation (from double-drop)
  bm-engine       decks, mixer, sync, loops, slip, scratch, beat FX; never allocates while rendering
  bm-analysis     tempo, beat grid, downbeat, key, loudness, waveform data (from double-drop)
  bm-decode       MP3/FLAC/WAV/AIFF/M4A/Ogg and tags, via Symphonia (from double-drop)
  bm-engine-wasm  the engine for the AudioWorklet (plain C-ABI exports, no wasm-bindgen)
  bm-worker-wasm  decoding and analysis for Web Workers (plain C-ABI exports)
web/
  public/worklet.js   runs engine.wasm on the audio thread
  src/audio           the engine's main-thread side, recorder
  src/workers         decoder/analyser worker pool
  src/state           decks, mixer, library (IndexedDB), settings
  src/ui              Solid components; waveforms and meters are canvases drawn every frame
  src/midi            Web MIDI, presets (DDJ-FLX4), MIDI learn
```
The engine runs in Rust on the browser's audio thread. The interface sends it parameter changes and reads its state (positions, meters) from shared memory every frame. Decoding and analysis run in a pool of workers; one is kept free so loading a deck never waits behind library analysis.

## Deploying
Cloudflare Pages serves `web/dist` with the headers in `web/public/_headers`. Without them the browser withholds shared memory and the meters update less often. The CI workflow deploys `main` when the repository has the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Then add `bangermix.horly.dev` as a custom domain of the `bangermix` Pages project.
