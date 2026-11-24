// Pioneer DDJ-FLX4. Messages from the Mixxx project's open mapping
// (res/controllers/Pioneer-DDJ-FLX4.midi.xml and -script.js): deck 1 on MIDI channel
// 1, deck 2 on channel 2; pads on 0x97/0x98 (deck 1, shifted) and 0x99/0x9A (deck 2);
// mixer-wide controls on 0xB6/0x96; beat FX on 0x94/0xB4. Untested on hardware here:
// if a direction is wrong, Settings → MIDI has "invert tempo".

import { FX, FX_TARGET_MASTER } from "../audio/params";
import { moveSelection, selected } from "../state/browser";
import { type Deck, decks, makeMaster } from "../state/deck";
import { trackById } from "../state/library";
import { mixer, setChannel, setCrossfader, setFx, setMixerValue } from "../state/mixer";
import { settings, setSettings } from "../state/settings";
import type { MidiOut, Preset } from "./preset";

/** Jog ticks per platter turn, and turns per second at normal speed. */
const TICKS_PER_REV = 720;
const REV_PER_S = (33 + 1 / 3) / 60;

const KEEPALIVE = [0xf0, 0x00, 0x40, 0x05, 0x00, 0x00, 0x04, 0x05, 0x00, 0x50, 0x02, 0xf7];
const PAD_MODES = { hotcue: 0x1b, beatjump: 0x20, beatloop: 0x6d, sampler: 0x22, padfx1: 0x1e, padfx2: 0x6b, keyboard: 0x69, keyshift: 0x6f };
type PadMode = keyof typeof PAD_MODES;
const LOOP_BEATS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
const JUMPS = [-1, 1, -2, 2, -4, 4, -8, 8];
const FX_CYCLE = [FX.ECHO, FX.REVERB, FX.FLANGER, FX.ROLL];

export function flx4(): Preset {
  const shift = [false, false];
  const padMode: PadMode[] = ["hotcue", "hotcue"];
  const msb = new Map<string, number>();
  const jog = [
    { touched: false, ticks: 0, speed: 0, timer: 0 as number | undefined },
    { touched: false, ticks: 0, speed: 0, timer: 0 as number | undefined },
  ];
  let keepalive: number | undefined;
  const ledCache = new Map<string, number>();

  /** 14-bit value from an MSB and its LSB (LSB arrives second). */
  const fine = (status: number, cc: number, value: number, lsbBase: number): number | null => {
    const key = `${status}:${cc}`;
    if (cc < lsbBase) {
      msb.set(key, value);
      return null;
    }
    const hi = msb.get(`${status}:${cc - 0x20}`) ?? 0;
    return ((hi << 7) | value) / 0x3fff;
  };

  const deckOf = (i: number): Deck => decks[i];

  const runJog = (i: number) => {
    const j = jog[i];
    // Platter speed from the ticks of the last 10 ms, smoothed a little.
    const measured = j.ticks / 0.01 / (TICKS_PER_REV * REV_PER_S);
    j.ticks = 0;
    j.speed += (measured - j.speed) * 0.5;
    const d = deckOf(i);
    if (j.touched && settings.vinyl) d.scratchSpeed(j.speed);
    if (!j.touched && Math.abs(j.speed) < 0.001) {
      clearInterval(j.timer);
      j.timer = undefined;
      d.bend(0);
    }
  };

  const jogTick = (i: number, value: number, mode: "scratch" | "bend" | "search") => {
    const delta = value - 64;
    const d = deckOf(i);
    if (mode === "search") {
      d.seek(d.live.pos + delta * 0.2);
      return;
    }
    if (mode === "bend" || !jog[i].touched || !settings.vinyl) {
      d.bend(Math.max(-0.4, Math.min(0.4, delta * 0.012)));
      const j = jog[i];
      clearTimeout(j.timer);
      j.timer = window.setTimeout(() => d.bend(0), 60);
      return;
    }
    jog[i].ticks += delta;
  };

  const pad = (i: number, n: number, shifted: boolean, down: boolean) => {
    const d = deckOf(i);
    const mode = padMode[i];
    if (mode === "hotcue") {
      if (!down) return;
      if (shifted) d.deleteHotCue(n);
      else d.hotCue(n);
    } else if (mode === "beatjump") {
      if (!down) return;
      if (shifted && n >= 6) {
        d.setJumpBeats(Math.max(1, Math.min(64, n === 6 ? d.jumpBeats() / 2 : d.jumpBeats() * 2)));
        return;
      }
      d.beatJump(JUMPS[n] * (d.jumpBeats() / 4 || 1));
    } else if (mode === "beatloop") {
      if (down) d.autoLoop(LOOP_BEATS[n]);
    } else if (mode === "padfx1" || mode === "padfx2") {
      // Pad FX: hold a pad for the beat FX at a length, on this deck.
      const beats = [0.25, 0.5, 0.75, 1, 0.125, 0.25, 0.5, 1][n];
      const type = mode === "padfx1" ? (n < 4 ? FX.ECHO : FX.ROLL) : n < 4 ? FX.REVERB : FX.FLANGER;
      if (down) {
        setFx("type", type);
        setFx("beats", beats);
        setFx("target", i);
        setFx("on", true);
      } else {
        setFx("on", false);
      }
    }
  };

  const handle = (data: Uint8Array, out: MidiOut) => {
    const [status, d1, d2] = data;
    const kind = status & 0xf0;
    const ch = status & 0x0f;
    const down = kind === 0x90 && d2 > 0;
    const isNote = kind === 0x90 || kind === 0x80;

    // Deck buttons and controls, channels 1 and 2.
    if (ch <= 1 && isNote) {
      const i = ch;
      const d = deckOf(i);
      switch (d1) {
        case 0x3f:
          shift[i] = down;
          return;
        case 0x0b:
          if (down) d.togglePlay();
          return;
        case 0x0e:
          d.setReverse(down);
          return;
        case 0x0c:
          if (down) d.cueDown();
          else d.cueUp();
          return;
        case 0x48:
          if (down) d.seek(0);
          return;
        case 0x68:
          if (down) setSettings("quantize", !settings.quantize);
          return;
        case 0x58:
          if (down) d.setSync(!d.sync());
          return;
        case 0x5c:
          if (down) makeMaster(d);
          return;
        case 0x60:
          if (down) d.cycleTempoRange();
          return;
        case 0x54:
          if (down) setChannel(i, "cue", !mixer.channels[i].cue);
          return;
        case 0x10:
          if (down) d.loopIn();
          return;
        case 0x11:
          if (down) d.loopOut();
          return;
        case 0x4d:
          if (down) d.reloopExit();
          return;
        case 0x50:
          if (down) {
            d.reloopExit();
            d.play(false);
          }
          return;
        case 0x51:
          if (down) d.loopResize(0.5);
          return;
        case 0x53:
          if (down) d.loopResize(2);
          return;
        case 0x3e:
          if (down) d.beatJump(-d.jumpBeats());
          return;
        case 0x3d:
          if (down) d.beatJump(d.jumpBeats());
          return;
        case 0x36:
        case 0x67: {
          const j = jog[i];
          j.touched = down;
          if (down && settings.vinyl) {
            j.speed = d.live.speed;
            d.scratchStart();
          } else if (!down) {
            d.scratchEnd();
          }
          if (!j.timer) j.timer = window.setInterval(() => runJog(i), 10);
          return;
        }
      }
      for (const [mode, note] of Object.entries(PAD_MODES)) {
        if (d1 === note && down) {
          padMode[i] = mode as PadMode;
          updateLeds(out, true);
          return;
        }
      }
      return;
    }

    // Pads.
    if (isNote && ch >= 7 && ch <= 10) {
      const i = ch <= 8 ? 0 : 1;
      const shifted = ch === 8 || ch === 10;
      pad(i, d1 & 0x07, shifted, down);
      return;
    }

    // Mixer-wide buttons.
    if (isNote && ch === 6) {
      if (!down) return;
      if (d1 === 0x46 || d1 === 0x47) {
        const id = selected();
        const t = id ? trackById(id) : undefined;
        if (t) void deckOf(d1 - 0x46).load(t);
      }
      return;
    }

    // Beat FX buttons.
    if (isNote && (ch === 4 || ch === 5)) {
      if (!down) return;
      if (d1 === 0x47) setFx("on", !mixer.fx.on);
      else if (d1 === 0x43) setFx("on", false);
      else if (d1 === 0x63 || d1 === 0x64) {
        const k = FX_CYCLE.indexOf(mixer.fx.type as (typeof FX_CYCLE)[number]);
        const step = d1 === 0x63 ? 1 : -1;
        setFx("type", FX_CYCLE[(k + step + FX_CYCLE.length) % FX_CYCLE.length]);
      } else if (d1 === 0x10) setFx("target", 0);
      else if (d1 === 0x11) setFx("target", 1);
      else if (d1 === 0x4a || d1 === 0x4b) {
        const beats = [0.125, 0.25, 0.5, 0.75, 1, 2, 4];
        const k = Math.max(0, beats.indexOf(mixer.fx.beats));
        setFx("beats", beats[Math.max(0, Math.min(beats.length - 1, k + (d1 === 0x4b ? 1 : -1)))]);
      }
      return;
    }

    if (kind !== 0xb0) return;

    // Deck CCs.
    if (ch <= 1) {
      const i = ch;
      switch (d1) {
        case 0x22:
          return jogTick(i, d2, "scratch");
        case 0x23:
        case 0x21:
          return jogTick(i, d2, "bend");
        case 0x29:
          return jogTick(i, d2, "search");
      }
      const v = fine(status, d1, d2, 0x20);
      if (v === null) return;
      switch (d1 - 0x20) {
        case 0x00: {
          const f = 1 - v * 2;
          deckOf(i).setTempoFader(settings.midiInvertTempo ? -f : f);
          return;
        }
        case 0x13:
          return setChannel(i, "fader", v);
        case 0x04:
          return setChannel(i, "trim", v * 2 - 1);
        case 0x07:
          return setChannel(i, "high", v);
        case 0x0b:
          return setChannel(i, "mid", v);
        case 0x0f:
          return setChannel(i, "low", v);
      }
      return;
    }

    if (ch === 6) {
      if (d1 === 0x40) {
        moveSelection(d2 < 0x40 ? d2 : d2 - 0x80);
        return;
      }
      if (d1 === 0x64) {
        setSettings("waveSeconds", Math.max(2, Math.min(60, settings.waveSeconds * (d2 === 0x7f ? 1 / 1.2 : 1.2))));
        return;
      }
      const v = fine(status, d1, d2, 0x20);
      if (v === null) return;
      switch (d1 - 0x20) {
        case 0x1f:
          return setCrossfader(v);
        case 0x17:
          return setChannel(0, "filter", v * 2 - 1);
        case 0x18:
          return setChannel(1, "filter", v * 2 - 1);
        case 0x0c:
          return setMixerValue("phonesMix", v);
      }
      return;
    }

    if (ch === 4 && d1 === 0x02) {
      if (shift[0] || shift[1]) setFx("param", d2 / 127);
      else setFx("wet", d2 / 127);
    }
  };

  const led = (out: MidiOut, status: number, note: number, on: boolean, force: boolean) => {
    const key = `${status}:${note}`;
    const v = on ? 0x7f : 0;
    if (!force && ledCache.get(key) === v) return;
    ledCache.set(key, v);
    out([status, note, v]);
  };

  const updateLeds = (out: MidiOut, force = false) => {
    for (let i = 0; i < 2; i++) {
      const d = deckOf(i);
      const st = 0x90 + i;
      const blink = Math.floor(performance.now() / 300) % 2 === 0;
      led(out, st, 0x0b, d.live.playing, force);
      led(out, st, 0x0c, !!d.track() && (Math.abs(d.live.pos - d.cuePoint()) < 0.02 || (!d.live.playing && blink)), force);
      led(out, st, 0x58, d.sync(), force);
      led(out, st, 0x54, mixer.channels[i].cue, force);
      led(out, st, 0x10, d.pendingIn() !== null || d.live.loopOn, force);
      led(out, st, 0x11, d.live.loopOn, force);
      led(out, st, 0x4d, d.live.loopOn, force);
      for (const [mode, note] of Object.entries(PAD_MODES)) led(out, st, note, padMode[i] === mode, force);
      const padSt = i === 0 ? 0x97 : 0x99;
      for (let n = 0; n < 8; n++) {
        let on = false;
        if (padMode[i] === "hotcue") on = !!d.track()?.hotCues[n];
        else if (padMode[i] === "beatloop")
          on = d.live.loopOn && Math.abs(d.live.loopOut - d.live.loopIn - LOOP_BEATS[n] * d.beat()) < 1e-3;
        else if (padMode[i] === "beatjump") on = true;
        const base = { hotcue: 0x00, beatjump: 0x20, beatloop: 0x60, sampler: 0x30, padfx1: 0x10, padfx2: 0x50, keyboard: 0x40, keyshift: 0x70 }[padMode[i]];
        led(out, padSt, base + n, on, force);
      }
      led(out, 0x9f, i, !!d.track(), force);
    }
    led(out, 0x94, 0x47, mixer.fx.on, force);
    led(out, 0x95, 0x47, mixer.fx.on && mixer.fx.target !== FX_TARGET_MASTER, force);
  };

  return {
    name: "Pioneer DDJ-FLX4",
    match: /DDJ-FLX4/i,
    sysex: true,
    start(out, sysex) {
      sysex?.(KEEPALIVE);
      keepalive = window.setInterval(() => sysex?.(KEEPALIVE), 200);
      updateLeds(out, true);
    },
    stop() {
      clearInterval(keepalive);
      for (const j of jog) clearInterval(j.timer);
    },
    message: handle,
    frame(out) {
      updateLeds(out);
      // VU meters on the decks' level LEDs.
      for (let i = 0; i < 2; i++) {
        const peak = Math.max(decks[i].peakL(), decks[i].peakR());
        const key = `vu${i}`;
        const v = Math.round(Math.min(1, peak) * 127);
        if (ledCache.get(key) !== v) {
          ledCache.set(key, v);
          out([0xb0 + i, 0x02, v]);
        }
      }
    },
  };
}
