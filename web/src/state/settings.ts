// User settings, kept in localStorage.

import { createStore } from "solid-js/store";
import { createEffect } from "solid-js";
import type { OutputMode } from "../audio/engine";

export type CrossfaderCurve = "smooth" | "linear" | "cut";
export type KeyNotation = "camelot" | "musical";

export interface Settings {
  outputMode: OutputMode;
  sinkId: string;
  /** The headphones' device in "device" output mode. */
  phonesSinkId: string;
  /** Master tempo on for newly loaded tracks. */
  keylockDefault: boolean;
  /** Sync lines up bars (downbeats), not just beats. */
  syncBars: boolean;
  waveformStyle: "rgb" | "3band";
  bpmMin: number;
  bpmMax: number;
  deckCount: 2 | 4;
  quantize: boolean;
  keyNotation: KeyNotation;
  /** Tempo fader range in percent: 6, 10, 16 or 100 (wide). */
  tempoRange: number;
  /** Seconds of track across the scrolling waveforms. */
  waveSeconds: number;
  crossfaderCurve: CrossfaderCurve;
  /** Beats a beat jump moves. */
  beatJump: number;
  /** Jog wheels and the waveform: scratch when touched (vinyl) or bend (CDJ). */
  vinyl: boolean;
  autoGain: boolean;
  midiPreset: string;
  midiInvertTempo: boolean;
}

const DEFAULTS: Settings = {
  outputMode: "stereo",
  sinkId: "default",
  phonesSinkId: "",
  keylockDefault: false,
  syncBars: true,
  waveformStyle: "rgb",
  bpmMin: 88,
  bpmMax: 175,
  deckCount: 2,
  quantize: true,
  keyNotation: "camelot",
  tempoRange: 10,
  waveSeconds: 10,
  crossfaderCurve: "smooth",
  beatJump: 4,
  vinyl: true,
  autoGain: false,
  midiPreset: "auto",
  midiInvertTempo: false,
};

const KEY = "bangermix.settings";

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return { ...DEFAULTS };
  }
}

export const [settings, setSettings] = createStore<Settings>(load());

export function persistSettings() {
  createEffect(() => {
    localStorage.setItem(KEY, JSON.stringify({ ...settings }));
  });
}
