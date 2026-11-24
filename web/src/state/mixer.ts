// The mixer: channel strips, crossfader, master, headphones and the beat FX unit.
// Knob and fader positions live here; each change is turned into engine gains.

import { createStore } from "solid-js/store";
import { FX, FX_TARGET_MASTER, G, P } from "../audio/params";
import { maybeEngine } from "./app";
import { decks } from "./deck";
import { settings } from "./settings";

export type XfAssign = "a" | "thru" | "b";

export interface Channel {
  /** -1 to 1 = -12 to +12 dB. */
  trim: number;
  /** 0 = killed, 0.5 = flat, 1 = +6 dB. */
  high: number;
  mid: number;
  low: number;
  /** -1 low-pass .. 0 off .. 1 high-pass. */
  filter: number;
  /** 0 to 1. */
  fader: number;
  cue: boolean;
  xf: XfAssign;
}

export interface FxState {
  type: number;
  /** Deck index, or 4 for the master. */
  target: number;
  beats: number;
  wet: number;
  param: number;
  on: boolean;
}

export interface MixerState {
  channels: Channel[];
  /** 0 = A side, 1 = B side. */
  crossfader: number;
  /** 0 to 1, 0.8 = unity. */
  master: number;
  /** 0 = cue only, 1 = master only. */
  phonesMix: number;
  phonesLevel: number;
  fx: FxState;
}

const channel = (xf: XfAssign): Channel => ({
  trim: 0,
  high: 0.5,
  mid: 0.5,
  low: 0.5,
  filter: 0,
  fader: 1,
  cue: false,
  xf,
});

export const [mixer, setMixer] = createStore<MixerState>({
  channels: [channel("thru"), channel("thru"), channel("thru"), channel("thru")],
  crossfader: 0.5,
  master: 0.8,
  phonesMix: 0.3,
  phonesLevel: 0.7,
  fx: { type: FX.ECHO, target: FX_TARGET_MASTER, beats: 0.75, wet: 0.6, param: 0.5, on: false },
});

const db = (x: number) => Math.pow(10, x / 20);

/** EQ knob to band gain: full left kills, centre is flat, full right is +6 dB. */
export function eqGain(knob: number): number {
  if (knob <= 0.02) return 0;
  if (knob < 0.5) return db(-30 * (1 - (knob - 0.02) / 0.48));
  return db(((knob - 0.5) / 0.5) * 6);
}

function faderGain(x: number): number {
  return x <= 0.001 ? 0 : x * x;
}

function crossfaderGain(side: XfAssign, x: number): number {
  if (side === "thru") return 1;
  const p = side === "a" ? x : 1 - x; // 0 = fully this side
  switch (settings.crossfaderCurve) {
    case "cut":
      return p > 0.97 ? 0 : 1;
    case "linear":
      return Math.min(1, 2 * (1 - p));
    default:
      // Full level up to the middle, then a constant-power fade.
      return Math.min(1, Math.SQRT2 * Math.cos((p * Math.PI) / 2));
  }
}

function autoGainDb(k: number): number {
  if (!settings.autoGain) return 0;
  const loud = decks[k].track()?.loudness;
  if (loud === undefined) return 0;
  return Math.max(-12, Math.min(12, -10 - loud));
}

export function applyChannel(k: number) {
  const e = maybeEngine();
  if (!e) return;
  const c = mixer.channels[k];
  e.set(k, P.TRIM, db(c.trim * 12 + autoGainDb(k)));
  e.set(k, P.EQ_HIGH, eqGain(c.high));
  e.set(k, P.EQ_MID, eqGain(c.mid));
  e.set(k, P.EQ_LOW, eqGain(c.low));
  e.set(k, P.FILTER, c.filter);
  e.set(k, P.VOLUME, faderGain(c.fader) * crossfaderGain(c.xf, mixer.crossfader));
  e.set(k, P.CUE, c.cue ? 1 : 0);
}

export function applyGlobal() {
  const e = maybeEngine();
  if (!e) return;
  const m = (mixer.master / 0.8) ** 2;
  e.setGlobal(G.MASTER_GAIN, m);
  e.setGlobal(G.CUE_MIX, mixer.phonesMix);
  e.setGlobal(G.PHONES_GAIN, mixer.phonesLevel ** 2 * 1.5);
  const fx = mixer.fx;
  e.setGlobal(G.FX_TYPE, fx.type);
  e.setGlobal(G.FX_TARGET, fx.target);
  e.setGlobal(G.FX_BEATS, fx.beats);
  e.setGlobal(G.FX_WET, fx.wet);
  e.setGlobal(G.FX_PARAM, fx.param);
  e.setGlobal(G.FX_ON, fx.on ? 1 : 0);
}

export function applyAll() {
  for (let k = 0; k < 4; k++) applyChannel(k);
  applyGlobal();
}

export function setChannel<K extends keyof Channel>(k: number, key: K, value: Channel[K]) {
  setMixer("channels", k, key as any, value as any);
  applyChannel(k);
}

export function setCrossfader(x: number) {
  setMixer("crossfader", Math.max(0, Math.min(1, x)));
  for (let k = 0; k < 4; k++) applyChannel(k);
}

export function setMixerValue(key: "master" | "phonesMix" | "phonesLevel", v: number) {
  setMixer(key, Math.max(0, Math.min(1, v)));
  applyGlobal();
}

export function setFx<K extends keyof FxState>(key: K, value: FxState[K]) {
  setMixer("fx", key, value as any);
  applyGlobal();
}
