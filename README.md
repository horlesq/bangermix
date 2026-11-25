# bangermix

A DJ app in the browser, laid out like the classic two-deck performance screen: scrolling 3-band waveforms on top, decks either side of a mixer, the library below. Everything runs on your computer: audio, analysis and the library. Nothing is uploaded. It goes online at **bangermix.horly.dev** as static files.

**Status (25 November 2026):** two or four decks, sync, keylock and key shift, loops, hot cues, beat FX, recording, a library from your music folder with rekordbox import, keyboard and mouse control, about 50 Pioneer, Traktor, Numark and Denon controllers, USB export for CDJs, XDJs and Denon players, and offline use. Tested in Chrome with generated tracks, simulated controller messages, and exports read back by rekordcrate and checked against libdjinterop's schema; not yet with a real controller or player. See [PLAN.md](PLAN.md) for what comes next.

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
- **Playlists:** + beside PLAYLISTS. Fill one as in rekordbox: drag tracks onto its name (Ctrl-click, Shift-click or `Ctrl A` to take several), right-click → *Add to…*, or drag a whole folder from the sidebar. An empty playlist offers its folders as buttons; files dropped on the window while a playlist is open go into it.
- **rekordbox:** export your collection (File → Export Collection in xml format), add the same music folders here, then Settings → Library → Import. Grids, keys, cues, loops, ratings and playlists come across.
- **Pads:** HOT CUE, BEAT LOOP and BEAT JUMP modes, as on a controller.
- **Keylock:** MT keeps the pitch when the tempo moves; − / + shifts the key; KEY SYNC shifts it into the master deck's key.
- **Mouse:** knobs and faders drag, double-click resets, Shift for fine moves. Drag a waveform or jog wheel to scratch (or nudge with *Vinyl* off). Scroll a waveform to zoom.
- **Keyboard:** `F1` lists every shortcut. Deck 1 is on the left hand (`Z` cue, `X` play, `C` sync, `D` keylock, `1–4` hot cues), deck 2 on the right (`M` cue, `,` play, `.` sync, `J` keylock, `7–0` hot cues).
- **Headphone cue:** Settings → Audio. A controller's 4-output sound card puts the headphones on outputs 3–4. Or pick a separate device for the headphones (USB headphones, a second sound card). With one plain stereo output, *split* puts the master in mono on the left and the headphones on the right (for a splitter cable).
- **Controllers:** Settings → Controllers → *Connect MIDI controllers*. A controller is recognised by its name and gets its mapping; you can pick another in the same place. Pioneer, Traktor, Numark and Denon controllers (about 50, listed under *Supported controllers*) use the Mixxx project's mappings, run through a compatibility layer. Most Traktor Kontrol models are HID devices, not MIDI: connect them with *Connect a HID controller*. Anything else: MIDI learn, one control at a time.
- **Recording:** ● REC records the master and saves a `.webm` file when stopped.
- **USB export:** the USB button beside PLAYLISTS. Tick playlists (or the whole collection), tick Pioneer and/or Denon, then pick the root of the stick (FAT32 or exFAT). The music is copied to `Contents/`; for Pioneer CDJ/XDJ players a rekordbox device library goes in `PIONEER/` (beat grids, hot cues with colours and names, memory cues, loops, waveforms for every player generation up to the CDJ-3000), for Denon players an Engine DJ library in `Engine Library/` (Engine 4.1 or newer). Both can share one stick. Exporting again only copies new files. Not written: rekordbox's newer Device Library Plus, which the OPUS-QUAD and OMNIS-DUO need.

## How it is built
```
crates/
  bm-dsp          filters, 3-band isolator EQ, DJ filter, limiter, interpolation (from double-drop)
  bm-engine       decks, mixer, sync, loops, slip, scratch, keylock (WSOLA), beat FX; never allocates while rendering
  bm-analysis     tempo, beat grid, downbeat, key, loudness, waveform data (from double-drop)
  bm-decode       MP3/FLAC/WAV/AIFF/M4A/Ogg and tags, via Symphonia (from double-drop)
  bm-engine-wasm  the engine for the AudioWorklet (plain C-ABI exports, no wasm-bindgen)
  bm-export       USB exports: rekordbox device library (export.pdb, ANLZ analysis files)
  bm-worker-wasm  decoding, analysis and exports for Web Workers (plain C-ABI exports)
third_party/
  rekordcrate     Pioneer device-export reader/writer (MPL-2.0), vendored; see PATCHES.md
web/
  public/worklet.js   runs engine.wasm on the audio thread
  src/audio           the engine's main-thread side, recorder
  src/workers         decoder/analyser worker pool
  src/state           decks, mixer, library (IndexedDB), settings
  src/ui              Solid components; waveforms and meters are canvases drawn every frame
  src/midi            Web MIDI and WebHID, MIDI learn
  src/midi/mixxx      runs Mixxx controller mappings: their XML, their scripts, Mixxx's controls
  src/export          USB export: copying, the Engine DJ database (SQLite via sql.js)
```
The engine runs in Rust on the browser's audio thread. The interface sends it parameter changes and reads its state (positions, meters) from shared memory every frame. Decoding and analysis run in a pool of workers; one is kept free so loading a deck never waits behind library analysis.

## Controller mappings from Mixxx
The [Mixxx](https://mixxx.org) project keeps open mappings for hundreds of controllers: an XML file of MIDI messages and a script for jogs, LEDs and shift layers. bangermix fetches a controller's files from Mixxx's GitHub repository, at release 2.5.6, the first time it is used, and caches them, so it then works offline. They are GPL-2.0-or-later and are not copied into this repository. The scripts run in a hidden iframe with the same `engine`, `midi` and `controller` objects Mixxx gives them, and Mixxx's controls (`[Channel1] play`, `[Master] crossfader`, …) map onto this app's decks, mixer, beat FX and browser. Controls with no counterpart here (samplers, stems, a second effect at once) are accepted and do nothing.

## USB export formats
- **Pioneer (rekordbox device library).** `export.pdb` is written by [rekordcrate](https://github.com/Holzhaus/rekordcrate) (MPL-2.0), vendored in `third_party/` with one addition so it can write in memory; it follows rekordbox's table layout, including quirks players depend on. The analysis files (`ANLZ0000.DAT`, `.EXT`, `.2EX`) are written by `crates/bm-export`, section for section as rekordbox writes them, from [Deep Symmetry's format analysis](https://djl-analysis.deepsymmetry.org/rekordbox-export-analysis/anlz.html), and placed where players look for them (the folder some players compute from the audio path). Phrase analysis is not written.
- **Denon (Engine DJ library).** Schema 3.0.0, built in the browser with SQLite. The schema (`web/src/export/engine-schema-3.0.0.sql`) is taken from [libdjinterop](https://github.com/xsco/libdjinterop) and stays under its LGPL-3.0 licence; the row values and blob encodings follow libdjinterop, which Mixxx uses for its Engine exports.

## Deploying
Cloudflare Pages serves `web/dist` with the headers in `web/public/_headers`. Without them the browser withholds shared memory and the meters update less often. The CI workflow deploys `main` when the repository has the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Then add `bangermix.horly.dev` as a custom domain of the `bangermix` Pages project.
