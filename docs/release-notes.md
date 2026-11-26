**The first public beta of BangerMix: a free DJ app for the browser and the desktop.** Everything runs on your own computer. It hasn't been tried on real DJ hardware yet, and that's where your help is needed.

**Try it in the browser, no install:** [bangermix.horly.dev](https://bangermix.horly.dev). Use Chrome or Edge.

## What's in it
- 2 or 4 decks with scrolling waveforms, beat sync, keylock and key shift, loops, beat jump, slip, 8 hot cues.
- A mixer laid out like a Pioneer DJM-900NXS2: 3-band EQ, 6 Sound Color FX on each channel's FX knob, 14 Beat FX.
- A library from your music folders, with BPM, key and beat-grid analysis.
- Import grids, cues and playlists from rekordbox, Serato DJ, Traktor, Engine DJ, Mixxx and VirtualDJ.
- About 50 Pioneer, Traktor, Numark and Denon controllers, using the Mixxx project's mappings, plus MIDI learn.
- USB export for Pioneer CDJ/XDJ players (rekordbox format) and Denon players (Engine DJ format).
- Recording, keyboard control, and offline use.

## Please help test
These are the parts I couldn't test myself. Even "it worked" is useful:
- **Your controller.** Does it get recognised? Do the jogs, pads, faders and lights work? [Report a controller](https://github.com/horlesq/bangermix/issues/new?template=controller.yml)
- **A USB stick on a real player.** Export a playlist, plug the stick into a CDJ, XDJ or Denon player, and check whether the tracks, grids, cues and waveforms show up. [Report a player](https://github.com/horlesq/bangermix/issues/new?template=player.yml)
- **Importing your library** from rekordbox, Serato, Traktor, Engine, Mixxx or VirtualDJ.
- **A long session.** Do you hear dropouts or glitches, or does it slow down over a whole set?

Anything else: [report a bug](https://github.com/horlesq/bangermix/issues/new?template=bug.yml).

## Desktop app
Download the installer for your system below. The desktop app works like the browser version, without the permission prompts, and keeps playing in the background.

- **Windows:** `BangerMix-Setup-….exe`. The installer isn't code-signed yet, so Windows SmartScreen warns: click **More info → Run anyway**.
- **macOS:** `.dmg` (Apple Silicon `arm64`, Intel `x64`). It's not signed, so right-click the app → **Open**. If macOS says the app "is damaged", run `xattr -cr /Applications/BangerMix.app` in Terminal.
- **Linux:** `.AppImage`. Make it executable (`chmod +x`), then run it.

## Known limits
- Not yet tried on real controllers or players: everything was tested in software only.
- The macOS and Linux builds haven't been run by anyone yet.
- USB export doesn't write rekordbox's newer *Device Library Plus*, which the OPUS-QUAD and OMNIS-DUO need.
- VirtualDJ's hot cues and beat grids haven't been tried with real files.
- In the browser, Firefox and Safari can play music, but can't use controllers, remember your music folder or write USB sticks.
