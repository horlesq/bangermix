// App-wide singletons: the audio engine and the worker pool.

import { createSignal } from "solid-js";
import { AudioEngine } from "../audio/engine";
import { WorkerPool } from "../workers/pool";
import { initLibrary } from "./library";
import { settings } from "./settings";

export const pool = new WorkerPool();
initLibrary(pool);

let engineRef: AudioEngine | null = null;
export const [audioReady, setAudioReady] = createSignal(false);
export const [audioError, setAudioError] = createSignal<string | null>(null);
export const [audioRunning, setAudioRunning] = createSignal(false);

/** The engine; only call once `audioReady()`. */
export function engine(): AudioEngine {
  if (!engineRef) throw new Error("audio not started");
  return engineRef;
}

export function maybeEngine(): AudioEngine | null {
  return engineRef;
}

export async function startAudio() {
  try {
    engineRef = await AudioEngine.start({ mode: settings.outputMode, sinkId: settings.sinkId });
    setAudioReady(true);
    const ctx = engineRef.ctx;
    const update = () => setAudioRunning(ctx.state === "running");
    ctx.onstatechange = update;
    update();
    // Browsers start audio suspended until the page is used.
    const resume = () => {
      if (ctx.state !== "running") void ctx.resume();
    };
    window.addEventListener("pointerdown", resume, true);
    window.addEventListener("keydown", resume, true);
  } catch (e) {
    console.error(e);
    setAudioError(String((e as Error).message ?? e));
  }
}

export const [toast, setToast] = createSignal<string | null>(null);
let toastTimer: number | undefined;
export function notify(text: string) {
  setToast(text);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => setToast(null), 3500);
}
