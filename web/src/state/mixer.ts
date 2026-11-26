// The mixer, after a Pioneer DJM-900NXS2: channel strips, crossfader, master,
// headphones, Sound Color FX and the beat FX unit.
// Knob and fader positions live here; each change is turned into engine gains.

import { createStore } from "solid-js/store";
import { COLOR, FX, FX_TARGET_MASTER, G, P } from "../audio/params";
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
  /** The COLOR knob: -1 .. 0 off .. 1, the Sound Color FX chosen for the mixer. */
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

export interface ColorState {
  /** One of COLOR, for every channel. */
  type: number;
  /** The PARAMETER knob, 0..1. */
  param: number;
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
  color: ColorState;
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
  color: { type: COLOR.FILTER, param: 0.5 },
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
  e.setGlobal(G.COLOR_TYPE, mixer.color.type);
  e.setGlobal(G.COLOR_PARAM, mixer.color.param);
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

export function setColor<K extends keyof ColorState>(key: K, value: ColorState[K]) {
  setMixer("color", key, value as any);
  applyGlobal();
}

/** Every beat FX, in the DJM-900NXS2's order. */
export const BEAT_FX_ORDER = [
  FX.DELAY,
  FX.ECHO,
  FX.PING_PONG,
  FX.SPIRAL,
  FX.REVERB,
  FX.TRANS,
  FX.FILTER,
  FX.FLANGER,
  FX.PHASER,
  FX.PITCH,
  FX.SLIP_ROLL,
  FX.ROLL,
  FX.VINYL_BRAKE,
  FX.HELIX,
] as number[];

/** The beat lengths the beat FX steps through. */
export const FX_BEAT_STEPS = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4, 8, 16];

/** The Sound Color FX, in the DJM's order. */
export const COLOR_ORDER = [COLOR.SPACE, COLOR.DUB_ECHO, COLOR.SWEEP, COLOR.NOISE, COLOR.CRUSH, COLOR.FILTER] as number[];

const step = (list: number[], current: number, dir: number) => {
  const i = list.indexOf(current);
  return list[((i < 0 ? 0 : i + dir) + list.length) % list.length];
};

export const cycleFx = (dir: number) => setFx("type", step(BEAT_FX_ORDER, mixer.fx.type, dir));
export const cycleColor = (dir: number) => setColor("type", step(COLOR_ORDER, mixer.color.type, dir));

export function stepFxBeats(dir: number) {
  const i = FX_BEAT_STEPS.indexOf(mixer.fx.beats);
  const at = i < 0 ? Math.max(0, FX_BEAT_STEPS.findIndex((b) => b >= mixer.fx.beats)) : i;
  setFx("beats", FX_BEAT_STEPS[Math.max(0, Math.min(FX_BEAT_STEPS.length - 1, at + dir))]);
}
