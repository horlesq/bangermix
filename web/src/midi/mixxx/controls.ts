// Mixxx's controls ("[Channel1] play", "[Master] crossfader" and the rest) laid over
// bangermix's decks, mixer, beat FX and browser, so that Mixxx's controller mappings
// can drive this app. Each control has a value (in Mixxx's units) and a parameter
// (0..1, what knobs and faders send), converted the way Mixxx converts them
// (src/control/controlbehavior.cpp). Controls this app has no equivalent for are kept
// as plain values, so scripts that use them for their own state still work.

import { FX, FX_TARGET_MASTER, SG } from "../../audio/params";
import { maybeEngine } from "../../state/app";
import { moveSelection, selected, setView, view, type View } from "../../state/browser";
import { type Deck, decks, makeMaster } from "../../state/deck";
import { folders, playlists, trackById } from "../../state/library";
import { type Channel, mixer, setChannel, setCrossfader, setFx, setMixerValue } from "../../state/mixer";
import { settings, setSettings } from "../../state/settings";

export interface Control {
  get(): number;
  set(v: number): void;
  /** How a MIDI message changes it: toggles flip on press, pushes follow the
   * button, values take the (converted) knob position. */
  kind: "toggle" | "push" | "value";
  /** States of a multi-state toggle (orientation has 3). */
  states?: number;
  toParam(v: number): number;
  fromParam(p: number): number;
  /** 0..127 from a controller to a parameter. */
  midiToParam(m: number): number;
  /** The value as a MIDI number, for relative (rot64, diff) messages. */
  valueToMidi(v: number): number;
}

/** Mixxx counts positions in samples: frames × 2 channels. Track rates differ, but
 * scripts only compare positions with each other and with track_samples. */
export const SAMPLE_RATE = 44100;
const toSamples = (s: number) => s * SAMPLE_RATE * 2;
const fromSamples = (n: number) => n / SAMPLE_RATE / 2;

const db2ratio = (db: number) => Math.pow(10, db / 20);
const ratio2db = (r: number) => 20 * Math.log10(r);
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

// --- Behaviours -------------------------------------------------------------------

type Get = () => number;
type Set = (v: number) => void;

function numeric(get: Get, set: Set, kind: Control["kind"] = "value", states?: number): Control {
  return {
    get,
    set,
    kind,
    states,
    toParam: (v) => v,
    fromParam: (p) => p,
    midiToParam: (m) => m / 127,
    valueToMidi: (v) => v * 127,
  };
}

const toggle = (get: () => boolean | number, set: (on: boolean) => void) =>
  numeric(
    () => +get(),
    (v) => set(v > 0),
    "toggle",
  );

/** A button that acts on press (and on release, when given). Reads back as held. */
function push(press: () => void, release?: () => void): Control {
  let held = 0;
  return numeric(
    () => held,
    (v) => {
      const now = v > 0 ? 1 : 0;
      if (now === held && now === 0) return;
      held = now;
      if (now) press();
      else release?.();
    },
    "push",
  );
}

/** A linear knob from min to max (ControlPotmeter). */
function pot(min: number, max: number, get: Get, set: Set): Control {
  const range = max - min;
  const toParam = (v: number) => (range === 0 ? 0 : (clamp(v, min, max) - min) / range);
  return {
    get,
    set,
    kind: "value",
    toParam,
    fromParam: (p) => min + p * range,
    // 64 is the centre.
    midiToParam: (m) => (m > 64 ? (m - 1) / 126 : m / 128),
    valueToMidi: (v) => {
      const p = toParam(v);
      return p > 0.5 ? p * 126 + 1 : p * 128;
    },
  };
}

/** A gain knob in dB with a neutral point (ControlAudioTaperPot): volume, pregain,
 * headphone and master gain. */
function taper(minDb: number, maxDb: number, neutral: number, get: Get, set: Set): Control {
  const offset = db2ratio(minDb);
  const maxValue = db2ratio(maxDb);
  const correction = Math.ceil(neutral * 127) - neutral * 127;
  const toParam = (v: number) => {
    if (v <= 0) return 0;
    if (v < 1) {
      const overlay = offset * (1 - v);
      return minDb !== 0 ? ((ratio2db(v + overlay) - minDb) / minDb) * neutral * -1 : v * neutral;
    }
    if (v === 1) return neutral;
    if (v < maxValue) return (ratio2db(v) / maxDb) * (1 - neutral) + neutral;
    return 1;
  };
  const fromParam = (p: number) => {
    if (p <= 0) return 0;
    if (p < neutral) {
      if (minDb === 0) return p / neutral;
      const db = (p * minDb) / (neutral * -1) + minDb;
      return (db2ratio(db) - offset) / (1 - offset);
    }
    if (p === neutral) return 1;
    if (p < 1) return db2ratio(((p - neutral) * maxDb) / (1 - neutral));
    return maxValue;
  };
  return {
    get,
    set,
    kind: "value",
    toParam,
    fromParam,
    midiToParam: (m) => {
      if (neutral === 0 || neutral === 1) return m / 127;
      if ((m - correction) / 127 < neutral) return m / (127 + correction / neutral);
      return (m - correction / neutral) / (127 - correction / neutral);
    },
    valueToMidi: (v) => {
      const p = toParam(v);
      let mid = p * 127;
      if (neutral !== 0 && neutral !== 1) {
        mid += p < neutral ? (correction * p) / neutral : (correction * (1 - p)) / neutral;
      }
      return mid;
    },
  };
}

/** A control given as a parameter (0..1) that this app stores as a knob position. */
function knob(get: Get, set: Set): Control {
  return pot(0, 1, get, set);
}

/** An EQ band: 0 kills, 1 is flat, 4 is the top (Mixxx's range); the knob centre is
 * flat as on this app's mixer. */
function eqBand(get: Get, set: Set): Control {
  const c = pot(0, 1, get, set);
  const toValue = (p: number) => (p <= 0.5 ? p * 2 : 1 + (p - 0.5) * 6);
  const toKnob = (v: number) => (v <= 1 ? Math.max(0, v) / 2 : Math.min(1, 0.5 + (v - 1) / 6));
  return {
    ...c,
    get: () => toValue(get()),
    set: (v) => set(toKnob(v)),
    toParam: toKnob,
    fromParam: toValue,
    valueToMidi: (v) => c.valueToMidi(toKnob(v)),
  };
}

// --- Plain values: controls this app has no equivalent for --------------------------

const store = new Map<string, number>();
const STORE_DEFAULTS: Record<string, number> = {
  rate_dir: -1,
  beatloop_size: 4,
  enabled: 1,
  mix: 1,
  loaded: 1,
  num_parameters: 3,
  show_parameters: 0,
  num_samplers: 4,
};

function plain(group: string, key: string): Control {
  const id = `${group} ${key}`;
  return numeric(
    () => store.get(id) ?? STORE_DEFAULTS[key] ?? 0,
    (v) => store.set(id, v),
  );
}

// --- Decks ------------------------------------------------------------------------

const FAST_SEARCH_S = 0.25;
const TEMP_RATE = 0.04;
const TEMP_RATE_SMALL = 0.01;
const PERM_RATE = 0.005;
const PERM_RATE_SMALL = 0.0005;

const blink = (ms: number) => Math.floor(performance.now() / ms) % 2 === 1;

function rateDir(d: Deck): number {
  const stored = store.get(`[Channel${d.index + 1}] rate_dir`) ?? -1;
  return settings.midiInvertTempo ? -stored : stored;
}

function rateRange(d: Deck): number {
  return d.tempoRange() / 100;
}

function deckRate(d: Deck): number {
  if (d.sync()) return ((d.live.tempo - 1) / rateRange(d)) * rateDir(d);
  return d.tempoFader() * rateDir(d);
}

function vu(peak: number): number {
  if (peak <= 0) return 0;
  return clamp((ratio2db(peak) + 42) / 42, 0, 1);
}

function loadSelected(d: Deck, play = false) {
  const id = selected();
  const t = id ? trackById(id) : undefined;
  if (!t) return;
  void d.load(t).then(() => {
    if (play && d.track()?.id === t.id) d.play(true);
  });
}

function firstStopped(): Deck | undefined {
  return decks.slice(0, settings.deckCount).find((d) => !d.live.playing);
}

/** Held fast-forward / rewind. */
function searcher(d: Deck, dir: 1 | -1) {
  let timer: number | undefined;
  return push(
    () => {
      clearInterval(timer);
      timer = window.setInterval(() => d.seek(d.live.pos + dir * FAST_SEARCH_S), 50);
    },
    () => clearInterval(timer),
  );
}

/** Jog: nudges while playing, scrubs while stopped (Mixxx's RateControl jog). */
const jogs = decks.map((d) => {
  let acc = 0;
  let smooth = 0;
  let timer: number | undefined;
  const tick = () => {
    smooth += (acc - smooth) * 0.35;
    acc = 0;
    const factor = smooth * 0.1;
    if (d.live.playing) d.bend(clamp(factor, -0.5, 0.5));
    else if (Math.abs(factor) > 1e-4) d.seek(d.live.pos + factor * 0.05);
    if (Math.abs(smooth) < 1e-3) {
      clearInterval(timer);
      timer = undefined;
      smooth = 0;
      d.bend(0);
    }
  };
  return {
    add(v: number) {
      acc += v;
      if (timer === undefined) timer = window.setInterval(tick, 10);
    },
  };
});

/** Platter speed while a script scratches (scratch2 with scratch2_enable). */
const scratch = decks.map(() => ({ on: false, speed: 0 }));

function setScratchEnable(d: Deck, on: boolean) {
  const s = scratch[d.index];
  if (on === s.on) return;
  s.on = on;
  if (on) {
    d.scratchStart();
    d.scratchSpeed(s.speed);
  } else {
    d.scratchEnd();
  }
}

const killed = decks.map(() => ({}) as Partial<Record<"low" | "mid" | "high", number>>);

function kill(k: number, band: "low" | "mid" | "high"): Control {
  return toggle(
    () => killed[k][band] !== undefined,
    (on) => {
      const prev = killed[k][band];
      if (on && prev === undefined) {
        killed[k][band] = mixer.channels[k][band];
        setChannel(k, band, 0);
      } else if (!on && prev !== undefined) {
        delete killed[k][band];
        setChannel(k, band, prev);
      }
    },
  );
}

function band(k: number, b: "low" | "mid" | "high"): Control {
  return eqBand(
    () => mixer.channels[k][b],
    (v) => {
      delete killed[k][b];
      setChannel(k, b, v);
    },
  );
}

const ORIENT: Channel["xf"][] = ["a", "thru", "b"];

const taps = decks.map(() => [] as number[]);

function tapTempo(d: Deck) {
  const now = performance.now();
  const t = taps[d.index];
  if (t.length && now - t[t.length - 1] > 2000) t.length = 0;
  t.push(now);
  if (t.length > 8) t.shift();
  if (t.length < 4 || !d.bpm()) return;
  const beat = (t[t.length - 1] - t[0]) / (t.length - 1) / 1000;
  const target = 60 / beat;
  if (d.sync()) d.setSync(false);
  d.setTempoFader(((target / d.bpm() - 1) * 100) / d.tempoRange());
}

/** One-shot sync (beatsync): engage sync for long enough to line up, then let go
 * at the synced tempo. */
function syncOnce(d: Deck) {
  if (d.sync()) return;
  d.setSync(true);
  window.setTimeout(() => d.setSync(false), 60);
}

function deckControl(d: Deck, key: string): Control | null {
  const k = d.index;
  const group = `[Channel${k + 1}]`;
  const loaded = () => !!d.track();
  const beatS = () => d.beat() || 0.5;
  const size = () => store.get(`${group} beatloop_size`) ?? 4;

  let m = key.match(/^hotcue_(\d+)_([a-z_]+)$/);
  if (m) {
    const i = +m[1] - 1;
    const cue = () => (i < 8 ? (d.track()?.hotCues[i] ?? null) : null);
    switch (m[2]) {
      case "activate":
      case "activatecue":
      case "activateloop":
        return push(
          () => i < 8 && d.hotCueDown(i),
          () => i < 8 && d.hotCueUp(i),
        );
      case "set":
        return push(() => {
          if (i >= 8) return;
          d.deleteHotCue(i);
          d.hotCue(i);
        });
      case "clear":
        return push(() => i < 8 && d.deleteHotCue(i));
      case "goto":
      case "gotoandstop":
        return push(() => {
          const c = cue();
          if (!c) return;
          if (m![2] === "gotoandstop") d.play(false);
          d.seek(c.time);
        });
      case "gotoandplay":
      case "gotoandloop":
        return push(() => {
          const c = cue();
          if (!c) return;
          d.seek(c.time);
          d.play(true);
        });
      case "enabled":
      case "status":
        return numeric(
          () => (cue() ? (d.previewingHotCue() === i ? 2 : 1) : 0),
          () => {},
        );
      case "type":
        return numeric(
          () => {
            const c = cue();
            return c ? (c.loopEnd !== undefined ? 4 : 1) : 0;
          },
          () => {},
        );
      case "color":
        return numeric(
          () => parseInt((cue()?.color ?? "#000000").slice(1), 16),
          () => {},
        );
      case "position":
        return numeric(
          () => {
            const c = cue();
            return c ? toSamples(c.time) : -1;
          },
          () => {},
        );
      case "endposition":
        return numeric(
          () => {
            const c = cue();
            return c?.loopEnd !== undefined ? toSamples(c.loopEnd) : -1;
          },
          () => {},
        );
    }
    return null;
  }

  m = key.match(/^beatloop_([\d.]+)_(activate|toggle|enabled)$/);
  if (m) {
    const beats = +m[1];
    const active = () => d.live.loopOn && Math.abs(d.live.loopOut - d.live.loopIn - beats * beatS()) < 1e-3;
    if (m[2] === "enabled") return numeric(() => +active(), () => {});
    if (m[2] === "toggle") return push(() => d.autoLoop(beats));
    return push(() => !active() && d.autoLoop(beats));
  }
  m = key.match(/^beatlooproll_([\d.]+)_activate$/);
  if (m) {
    const beats = +m[1];
    return push(
      () => d.rollStart(beats),
      () => d.rollEnd(),
    );
  }
  m = key.match(/^beatjump_([\d.]+)_(forward|backward)$/);
  if (m) {
    const beats = +m[1] * (m[2] === "forward" ? 1 : -1);
    return push(() => d.beatJump(beats));
  }
  m = key.match(/^loop_move_([\d.]+)_(forward|backward)$/);
  if (m) {
    const beats = +m[1] * (m[2] === "forward" ? 1 : -1);
    return push(() => d.loopMove(beats));
  }

  switch (key) {
    // Transport
    case "play":
      return toggle(
        () => d.live.playing,
        (on) => d.play(on),
      );
    case "play_indicator":
    case "play_latched":
      return numeric(() => +d.live.playing, () => {});
    case "stop":
      return push(() => d.play(false));
    case "start":
      return push(() => d.seek(0));
    case "end":
      return push(() => d.seek(Math.max(0, (d.live.duration || 0) - 0.5)));
    case "start_play":
      return push(() => {
        d.seek(0);
        d.play(true);
      });
    case "start_stop":
      return push(() => {
        d.play(false);
        d.seek(0);
      });
    case "cue_default":
    case "cue_cdj":
    case "cue_simple":
      return push(
        () => d.cueDown(),
        () => d.cueUp(),
      );
    case "cue_preview":
      return push(
        () => {
          d.seek(d.cuePoint());
          d.play(true);
        },
        () => {
          d.play(false);
          d.seek(d.cuePoint());
        },
      );
    case "cue_set":
      return push(() => d.setCueAt(d.quant(d.live.pos)));
    case "cue_clear":
      return push(() => d.setCueAt(0));
    case "cue_goto":
      return push(() => d.seek(d.cuePoint()));
    case "cue_gotoandplay":
    case "play_stutter":
      return push(() => {
        d.seek(d.cuePoint());
        d.play(true);
      });
    case "cue_gotoandstop":
      return push(() => {
        d.play(false);
        d.seek(d.cuePoint());
      });
    case "cue_play":
      return push(() => {
        d.seek(d.cuePoint());
        d.play(true);
      });
    case "cue_point":
      return numeric(
        () => (loaded() ? toSamples(d.cuePoint()) : -1),
        (v) => v >= 0 && d.setCueAt(fromSamples(v)),
      );
    case "cue_indicator":
      return numeric(() => {
        if (!loaded()) return 0;
        if (Math.abs(d.live.pos - d.cuePoint()) < 0.02) return 1;
        return !d.live.playing && blink(500) ? 1 : 0;
      }, () => {});
    case "fwd":
      return searcher(d, 1);
    case "back":
      return searcher(d, -1);
    case "reverse":
      return push(
        () => d.setReverse(true),
        () => d.setReverse(false),
      );
    case "reverseroll": {
      let slip = false;
      return push(
        () => {
          slip = d.slip();
          d.setSlip(true);
          d.setReverse(true);
        },
        () => {
          d.setReverse(false);
          d.setSlip(slip);
        },
      );
    }
    case "slip_enabled":
      return toggle(
        () => d.slip(),
        (on) => d.setSlip(on),
      );
    case "eject":
      return push(() => d.eject());
    case "LoadSelectedTrack":
      return push(() => loadSelected(d));
    case "LoadSelectedTrackAndPlay":
      return push(() => loadSelected(d, true));
    case "CloneFromDeck":
      return numeric(
        () => 0,
        (v) => {
          const t = decks[v - 1]?.track();
          if (t) void d.load(t);
        },
      );

    // Position and track
    case "playposition":
      return numeric(
        () => (d.live.duration ? d.live.pos / d.live.duration : 0),
        (v) => loaded() && d.seek(v * (d.live.duration || 0)),
      );
    case "track_loaded":
      return numeric(() => +loaded(), () => {});
    case "duration":
      return numeric(() => (loaded() ? d.live.duration : 0), () => {});
    case "track_samples":
      return numeric(() => (loaded() ? toSamples(d.live.duration) : 0), () => {});
    case "track_samplerate":
      return numeric(() => (loaded() ? SAMPLE_RATE : 0), () => {});
    case "end_of_track":
      return numeric(
        () => +(loaded() && d.live.playing && d.live.duration - d.live.pos < 30),
        () => {},
      );
    case "spinny_angle":
      return numeric(() => ((d.live.pos * (100 / 3 / 60) * 360) % 360) - 180, () => {});
    case "track_color":
      return plain(group, key);

    // Tempo
    case "rate":
      return pot(-1, 1, () => deckRate(d), (v) => {
        if (d.sync()) return;
        d.setTempoFader(v * rateDir(d));
      });
    case "rateRange":
      return numeric(
        () => rateRange(d),
        (v) => v > 0 && d.setTempoRange(Math.round(v * 100)),
      );
    case "rate_dir":
      return plain(group, key);
    case "rate_ratio":
    case "tempo_ratio":
      return numeric(() => d.live.tempo, () => {});
    case "bpm":
    case "visual_bpm":
      return numeric(
        () => d.currentBpm(),
        (v) => {
          if (key !== "bpm" || !d.bpm() || v <= 0 || d.sync()) return;
          d.setTempoFader(((v / d.bpm() - 1) * 100) / d.tempoRange());
        },
      );
    case "file_bpm":
    case "local_bpm":
      return numeric(() => d.bpm(), () => {});
    case "rate_temp_up":
    case "rate_temp_down":
    case "rate_temp_up_small":
    case "rate_temp_down_small": {
      const amount = (key.includes("small") ? TEMP_RATE_SMALL : TEMP_RATE) * (key.includes("up") ? 1 : -1);
      return push(
        () => d.bend(amount),
        () => d.bend(0),
      );
    }
    case "rate_perm_up":
    case "rate_perm_down":
    case "rate_perm_up_small":
    case "rate_perm_down_small": {
      const step = (key.includes("small") ? PERM_RATE_SMALL : PERM_RATE) * (key.includes("up") ? 1 : -1);
      return push(() => !d.sync() && d.setTempoFader(d.tempoFader() + step / rateRange(d)));
    }
    case "rate_set_default":
    case "rate_set_zero":
      return push(() => d.resetTempo());
    case "bpm_tap":
    case "tempo_tap":
      return push(() => tapTempo(d));
    case "sync_enabled":
      return toggle(
        () => d.sync(),
        (on) => d.setSync(on),
      );
    case "beatsync":
    case "beatsync_tempo":
    case "beatsync_phase":
      return push(() => syncOnce(d));
    case "sync_leader":
    case "sync_master":
      return toggle(
        () => d.master(),
        (on) => (on ? makeMaster(d) : d.setMaster(false)),
      );
    case "sync_mode":
      return numeric(() => (d.master() ? 2 : d.sync() ? 1 : 0), () => {});
    case "quantize":
      return toggle(
        () => settings.quantize,
        (on) => setSettings("quantize", on),
      );

    // Key
    case "keylock":
      return toggle(
        () => d.keylock(),
        (on) => d.setKeylock(on),
      );
    case "pitch":
    case "pitch_adjust":
      return numeric(
        () => d.keyShift(),
        (v) => d.setKeyShift(v),
      );
    case "pitch_up":
    case "pitch_adjust_up":
      return push(() => d.setKeyShift(d.keyShift() + 1));
    case "pitch_down":
    case "pitch_adjust_down":
      return push(() => d.setKeyShift(d.keyShift() - 1));
    case "reset_key":
    case "pitch_adjust_set_default":
      return push(() => d.setKeyShift(0));
    case "sync_key":
      return push(() => d.keySync());

    // Platter
    case "jog":
    case "wheel":
    case "scratch":
      return numeric(
        () => 0,
        (v) => v && jogs[k].add(v),
      );
    case "scratch2":
      return numeric(
        () => scratch[k].speed,
        (v) => {
          scratch[k].speed = v;
          if (scratch[k].on) d.scratchSpeed(v);
        },
      );
    case "scratch2_enable":
      return toggle(
        () => scratch[k].on,
        (on) => setScratchEnable(d, on),
      );

    // Beats and grid
    case "beat_active":
      return numeric(() => {
        if (!d.hasGrid() || !d.live.playing) return 0;
        const f = d.beatAt(d.heardPos()) % 1;
        return (f + 1) % 1 < 0.2 ? 1 : 0;
      }, () => {});
    case "beat_distance":
      return numeric(() => (d.hasGrid() ? (((d.beatAt(d.live.pos) % 1) + 1) % 1) : 0), () => {});
    case "beat_closest":
    case "beat_next":
    case "beat_prev":
      return numeric(() => {
        if (!d.hasGrid()) return -1;
        const b = d.beatAt(d.live.pos);
        const n = key === "beat_closest" ? Math.round(b) : key === "beat_next" ? Math.ceil(b) : Math.floor(b);
        return toSamples(d.timeOfBeat(n));
      }, () => {});
    case "beats_translate_curpos":
    case "beats_translate_match_alignment":
      return push(() => d.gridDownbeatHere());
    case "beats_translate_earlier":
      return push(() => d.gridShift(-10));
    case "beats_translate_later":
      return push(() => d.gridShift(10));
    case "beats_adjust_faster":
      return push(() => d.gridBpm(0.01));
    case "beats_adjust_slower":
      return push(() => d.gridBpm(-0.01));

    // Loops and jumps
    case "loop_in":
      return push(() => d.loopIn());
    case "loop_out":
      return push(() => d.loopOut());
    case "loop_enabled":
      return numeric(
        () => +d.live.loopOn,
        (v) => d.setLoopOn(v > 0),
      );
    case "reloop_toggle":
    case "reloop_exit":
      return push(() => d.reloopExit());
    case "reloop_andstop":
      return push(() => {
        d.play(false);
        d.seek(d.live.loopIn);
        d.setLoopOn(true);
      });
    case "loop_double":
      return push(() =>
        d.live.loopOut > d.live.loopIn ? d.loopResize(2) : store.set(`${group} beatloop_size`, Math.min(512, size() * 2)),
      );
    case "loop_halve":
      return push(() =>
        d.live.loopOut > d.live.loopIn
          ? d.loopResize(0.5)
          : store.set(`${group} beatloop_size`, Math.max(1 / 32, size() / 2)),
      );
    case "loop_scale":
      return numeric(
        () => 1,
        (v) => v > 0 && d.loopResize(v),
      );
    case "loop_move":
      return numeric(
        () => 0,
        (v) => v && d.loopMove(v),
      );
    case "loop_remove":
      return push(() => d.setLoopOn(false));
    case "loop_in_goto":
      return push(() => d.live.loopOut > d.live.loopIn && d.seek(d.live.loopIn));
    case "loop_out_goto":
      return push(() => d.live.loopOut > d.live.loopIn && d.seek(d.live.loopOut));
    case "loop_start_position":
    case "loop_end_position": {
      const start = key === "loop_start_position";
      return numeric(
        () => {
          if (!(d.live.loopOut > d.live.loopIn)) return -1;
          return toSamples(start ? d.live.loopIn : d.live.loopOut);
        },
        (v) => {
          if (v < 0) return;
          const t = fromSamples(v);
          const a = start ? t : d.live.loopIn;
          const b = start ? d.live.loopOut : t;
          d.setLoopPoints(a, b, d.live.loopOn);
        },
      );
    }
    case "beatloop_size":
      return numeric(
        size,
        (v) => v > 0 && store.set(`${group} beatloop_size`, v),
      );
    case "beatloop_activate":
      return push(() => d.autoLoop(size()));
    case "beatloop_toggle":
      return push(() => d.autoLoop(size()));
    case "beatlooproll_activate":
      return push(
        () => d.rollStart(size()),
        () => d.rollEnd(),
      );
    case "beatjump_size":
      return numeric(
        () => d.jumpBeats(),
        (v) => v > 0 && d.setJumpBeats(v),
      );
    case "beatjump_forward":
      return push(() => d.beatJump(d.jumpBeats()));
    case "beatjump_backward":
      return push(() => d.beatJump(-d.jumpBeats()));
    case "beatjump":
      return numeric(
        () => 0,
        (v) => v && d.beatJump(v),
      );

    // Channel strip
    case "volume":
      // The fader's position is Mixxx's parameter; its value goes through the taper.
      return taper(
        -20,
        0,
        1,
        () => volumeTaper.fromParam(mixer.channels[k].fader),
        (v) => setChannel(k, "fader", volumeTaper.toParam(v)),
      );
    case "pregain":
      return taper(-12, 12, 0.5, () => db2ratio(mixer.channels[k].trim * 12), (v) =>
        setChannel(k, "trim", clamp(ratio2db(Math.max(v, 1e-4)) / 12, -1, 1)),
      );
    case "pfl":
      return toggle(
        () => mixer.channels[k].cue,
        (on) => setChannel(k, "cue", on),
      );
    case "orientation":
      return numeric(
        () => ORIENT.indexOf(mixer.channels[k].xf),
        (v) => setChannel(k, "xf", ORIENT[clamp(Math.round(v), 0, 2)]),
        "toggle",
        3,
      );
    case "filterLow":
      return band(k, "low");
    case "filterMid":
      return band(k, "mid");
    case "filterHigh":
      return band(k, "high");
    case "filterLowKill":
      return kill(k, "low");
    case "filterMidKill":
      return kill(k, "mid");
    case "filterHighKill":
      return kill(k, "high");
    case "VuMeter":
    case "vu_meter":
      return numeric(() => vu(Math.max(d.peakL(), d.peakR())), () => {});
    case "VuMeterL":
    case "vu_meter_left":
      return numeric(() => vu(d.peakL()), () => {});
    case "VuMeterR":
    case "vu_meter_right":
      return numeric(() => vu(d.peakR()), () => {});
    case "PeakIndicator":
    case "peak_indicator":
      return numeric(() => +(Math.max(d.peakL(), d.peakR()) >= 0.99), () => {});
    case "PeakIndicatorL":
    case "peak_indicator_left":
      return numeric(() => +(d.peakL() >= 0.99), () => {});
    case "PeakIndicatorR":
    case "peak_indicator_right":
      return numeric(() => +(d.peakR() >= 0.99), () => {});

    // View
    case "waveform_zoom":
      return numeric(
        () => settings.waveSeconds / 5,
        (v) => setSettings("waveSeconds", clamp(v * 5, 2, 60)),
      );
    case "waveform_zoom_up":
      return push(() => setSettings("waveSeconds", clamp(settings.waveSeconds / 1.25, 2, 60)));
    case "waveform_zoom_down":
      return push(() => setSettings("waveSeconds", clamp(settings.waveSeconds * 1.25, 2, 60)));
    case "waveform_zoom_set_default":
      return push(() => setSettings("waveSeconds", 10));
    case "stem_count":
      return numeric(() => 0, () => {});
  }
  return null;
}

/** Channel fader position ↔ Mixxx's volume value. */
const volumeTaper = taper(-20, 0, 1, () => 0, () => {});

// --- Effects ----------------------------------------------------------------------

const FX_CYCLE = [FX.ECHO, FX.REVERB, FX.FLANGER, FX.ROLL];
const FX_BEATS = [0.125, 0.25, 0.5, 0.75, 1, 2, 4];
/** The type each slot of each effect unit plays (Mixxx units hold three effects). */
const slots = [0, 1, 2, 3].map(() => [FX.ECHO, FX.REVERB, FX.FLANGER] as number[]);
let activeSlot: { u: number; m: number } | null = null;

function slotEnabled(u: number, m: number): Control {
  return toggle(
    () => !!activeSlot && activeSlot.u === u && activeSlot.m === m && mixer.fx.on,
    (on) => {
      if (on) {
        activeSlot = { u, m };
        setFx("type", slots[u][m]);
        setFx("on", true);
      } else if (activeSlot?.u === u && activeSlot.m === m) {
        setFx("on", false);
      }
    },
  );
}

function cycleSlot(u: number, m: number, dir: number) {
  const i = FX_CYCLE.indexOf(slots[u][m] as (typeof FX_CYCLE)[number]);
  slots[u][m] = FX_CYCLE[(i + dir + FX_CYCLE.length) % FX_CYCLE.length];
  if (activeSlot?.u === u && activeSlot.m === m) setFx("type", slots[u][m]);
}

function effectControl(u: number, m: number, key: string, group: string): Control | null {
  switch (key) {
    case "enabled":
      return slotEnabled(u, m);
    case "meta":
    case "parameter1":
      return knob(
        () => mixer.fx.param,
        (v) => setFx("param", clamp(v, 0, 1)),
      );
    case "parameter2":
      return knob(
        () => FX_BEATS.indexOf(mixer.fx.beats) / (FX_BEATS.length - 1),
        (v) => setFx("beats", FX_BEATS[Math.round(clamp(v, 0, 1) * (FX_BEATS.length - 1))]),
      );
    case "parameter3":
      return knob(
        () => mixer.fx.wet,
        (v) => setFx("wet", clamp(v, 0, 1)),
      );
    case "effect_selector":
      return numeric(
        () => 0,
        (v) => v && cycleSlot(u, m, Math.sign(v)),
      );
    case "next_effect":
      return push(() => cycleSlot(u, m, 1));
    case "prev_effect":
      return push(() => cycleSlot(u, m, -1));
    case "loaded":
      return numeric(() => 1, () => {});
    case "num_parameters":
      return numeric(() => 3, () => {});
  }
  return plain(group, key);
}

function unitControl(u: number, key: string, group: string): Control | null {
  const m = key.match(/^group_\[(Channel(\d)|Master|Main)\]_enable$/);
  if (m) {
    const target = m[2] ? +m[2] - 1 : FX_TARGET_MASTER;
    return toggle(
      () => mixer.fx.target === target,
      (on) => {
        if (on) setFx("target", target);
        else if (mixer.fx.target === target) setFx("target", FX_TARGET_MASTER);
      },
    );
  }
  switch (key) {
    case "mix":
      return knob(
        () => mixer.fx.wet,
        (v) => setFx("wet", clamp(v, 0, 1)),
      );
    case "super1":
      return knob(
        () => mixer.fx.param,
        (v) => setFx("param", clamp(v, 0, 1)),
      );
    case "enabled":
      // Units are always on here; switching one off silences its effect.
      return toggle(
        () => 1,
        (on) => !on && activeSlot?.u === u && setFx("on", false),
      );
  }
  return plain(group, key);
}

// --- Mixer-wide, library, app -------------------------------------------------------

/** Master and headphone gain: unity at 0.8 on this app's master knob. */
function masterKnobToParam(x: number) {
  return x <= 0.8 ? (x / 0.8) * 0.5 : 0.5 + ((x - 0.8) / 0.2) * 0.5;
}
function paramToMasterKnob(p: number) {
  return p <= 0.5 ? (p / 0.5) * 0.8 : 0.8 + ((p - 0.5) / 0.5) * 0.2;
}

function mainControl(key: string, group: string): Control | null {
  const e = () => maybeEngine();
  switch (key) {
    case "crossfader":
      return pot(-1, 1, () => mixer.crossfader * 2 - 1, (v) => setCrossfader((v + 1) / 2));
    case "headMix":
      return pot(-1, 1, () => mixer.phonesMix * 2 - 1, (v) => setMixerValue("phonesMix", (v + 1) / 2));
    case "gain": {
      const c = taper(-14, 14, 0.5, () => 0, () => {});
      return taper(
        -14,
        14,
        0.5,
        () => c.fromParam(masterKnobToParam(mixer.master)),
        (v) => setMixerValue("master", paramToMasterKnob(c.toParam(v))),
      );
    }
    case "headGain":
    case "headVolume": {
      const c = taper(-14, 14, 0.5, () => 0, () => {});
      return taper(
        -14,
        14,
        0.5,
        () => c.fromParam(mixer.phonesLevel),
        (v) => setMixerValue("phonesLevel", c.toParam(v)),
      );
    }
    case "VuMeterL":
    case "vu_meter_left":
      return numeric(() => vu(e()?.global(SG.MASTER_PEAK_L) ?? 0), () => {});
    case "VuMeterR":
    case "vu_meter_right":
      return numeric(() => vu(e()?.global(SG.MASTER_PEAK_R) ?? 0), () => {});
    case "VuMeter":
    case "vu_meter":
      return numeric(
        () => vu(Math.max(e()?.global(SG.MASTER_PEAK_L) ?? 0, e()?.global(SG.MASTER_PEAK_R) ?? 0)),
        () => {},
      );
    case "PeakIndicatorL":
    case "peak_indicator_left":
      return numeric(() => +((e()?.global(SG.MASTER_PEAK_L) ?? 0) >= 0.99), () => {});
    case "PeakIndicatorR":
    case "peak_indicator_right":
      return numeric(() => +((e()?.global(SG.MASTER_PEAK_R) ?? 0) >= 0.99), () => {});
    case "PeakIndicator":
    case "peak_indicator":
      return numeric(
        () => +(Math.max(e()?.global(SG.MASTER_PEAK_L) ?? 0, e()?.global(SG.MASTER_PEAK_R) ?? 0) >= 0.99),
        () => {},
      );
    case "num_decks":
      return numeric(() => settings.deckCount, () => {});
    case "num_preview_decks":
    case "num_microphones":
    case "num_auxiliaries":
      return numeric(() => 0, () => {});
    case "samplerate":
      return numeric(() => e()?.ctx.sampleRate ?? 48000, () => {});
    case "indicator_250ms":
      return numeric(() => +blink(250), () => {});
    case "indicator_500ms":
      return numeric(() => +blink(500), () => {});
  }
  return plain(group, key);
}

/** The browser's views in order, for "next/previous playlist". */
function views(): View[] {
  return [
    { kind: "collection" },
    ...folders().map((f) => ({ kind: "folder" as const, id: f.id })),
    ...playlists().map((p) => ({ kind: "playlist" as const, id: p.id })),
  ];
}

function moveView(dir: number) {
  const all = views();
  const cur = view();
  const i = all.findIndex((v) => v.kind === cur.kind && (v.kind === "collection" || (cur.kind !== "collection" && v.id === cur.id)));
  setView(all[(Math.max(0, i) + dir + all.length) % all.length]);
}

function libraryControl(key: string, group: string): Control | null {
  const rel = (f: (n: number) => void) =>
    numeric(
      () => 0,
      (v) => v && f(Math.round(v)),
      "value",
    );
  switch (key) {
    case "MoveVertical":
    case "SelectTrackKnob":
      return { ...rel(moveSelection), midiToParam: (m) => m, valueToMidi: (v) => v };
    case "ScrollVertical":
      return { ...rel((n) => moveSelection(n * 10)), midiToParam: (m) => m, valueToMidi: (v) => v };
    case "MoveUp":
    case "SelectPrevTrack":
      return push(() => moveSelection(-1));
    case "MoveDown":
    case "SelectNextTrack":
      return push(() => moveSelection(1));
    case "SelectPlaylist":
      return { ...rel(moveView), midiToParam: (m) => m, valueToMidi: (v) => v };
    case "SelectNextPlaylist":
      return push(() => moveView(1));
    case "SelectPrevPlaylist":
      return push(() => moveView(-1));
    case "GoToItem":
    case "LoadSelectedIntoFirstStopped":
      return push(() => {
        const d = firstStopped();
        if (d) loadSelected(d);
      });
  }
  return plain(group, key);
}

// --- Lookup -------------------------------------------------------------------------

const cache = new Map<string, Control | null>();

/** The control for a group and key, or null where Mixxx would have none either. */
export function control(group: string, key: string): Control | null {
  if (typeof group !== "string" || typeof key !== "string") return null;
  const id = `${group} ${key}`;
  if (cache.has(id)) return cache.get(id)!;
  const c = resolve(group, key);
  cache.set(id, c);
  return c;
}

function resolve(group: string, key: string): Control | null {
  let m = group.match(/^\[Channel([1-4])\]$/);
  if (m) return deckControl(decks[+m[1] - 1], key) ?? plain(group, key);

  m = group.match(/^\[EqualizerRack1_\[Channel([1-4])\]_Effect1\]$/);
  if (m) {
    const k = +m[1] - 1;
    const bands = { 1: "low", 2: "mid", 3: "high" } as const;
    const p = key.match(/^(button_)?parameter([123])$/);
    if (p) {
      const b = bands[+p[2] as 1 | 2 | 3];
      return p[1] ? kill(k, b) : band(k, b);
    }
    return plain(group, key);
  }

  m = group.match(/^\[QuickEffectRack1_\[Channel([1-4])\](_Effect1)?\]$/);
  if (m) {
    const k = +m[1] - 1;
    if (key === "super1" || (m[2] && key === "parameter1")) {
      return knob(
        () => (mixer.channels[k].filter + 1) / 2,
        (v) => setChannel(k, "filter", clamp(v * 2 - 1, -1, 1)),
      );
    }
    return plain(group, key);
  }

  m = group.match(/^\[EffectRack1_EffectUnit([1-4])\]$/);
  if (m) return unitControl(+m[1] - 1, key, group);
  m = group.match(/^\[EffectRack1_EffectUnit([1-4])_Effect([1-3])\]$/);
  if (m) return effectControl(+m[1] - 1, +m[2] - 1, key, group);

  if (group === "[Master]" || group === "[Main]" || group === "[Mixer]" || group === "[App]") return mainControl(key, group);
  if (group === "[Library]" || group === "[Playlist]") return libraryControl(key, group);
  return plain(group, key);
}

/** Forgets plain values between controller sessions (a reconnected controller starts
 * from Mixxx's defaults, as it would in Mixxx after a restart). */
export function resetPlainValues() {
  store.clear();
}
