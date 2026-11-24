// One requestAnimationFrame loop for the whole interface: it reads the engine, keeps a
// smooth playhead per deck, and lets canvases draw.

import { maybeEngine } from "../state/app";
import { decks, updateMaster } from "../state/deck";

type FrameFn = (now: number) => void;
const callbacks = new Set<FrameFn>();

export function onFrame(f: FrameFn): () => void {
  callbacks.add(f);
  return () => callbacks.delete(f);
}

/** The playhead each deck is drawn at: the engine's position as heard, smoothed,
 * because the audio thread reports in bursts. */
export const displayPos = [0, 0, 0, 0];
const lastPlaying = [false, false, false, false];
let lastNow = 0;

function tick(now: number) {
  const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
  lastNow = now;
  const e = maybeEngine();
  let playingChanged = false;
  for (const d of decks) {
    d.poll();
    if (d.live.playing !== lastPlaying[d.index]) {
      lastPlaying[d.index] = d.live.playing;
      playingChanged = true;
    }
    if (e) {
      const target = d.heardPos();
      const predicted = displayPos[d.index] + d.live.speed * dt;
      const err = target - predicted;
      displayPos[d.index] = Math.abs(err) > 0.05 ? target : predicted + err * 0.15;
    }
  }
  if (playingChanged) updateMaster();
  for (const f of callbacks) f(now);
  requestAnimationFrame(tick);
}

export function startFrameLoop() {
  requestAnimationFrame(tick);
}
