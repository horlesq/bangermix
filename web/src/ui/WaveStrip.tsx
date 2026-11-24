// The scrolling waveforms of every deck, stacked, playhead in the middle. Drag one to
// scratch (or nudge, in CDJ mode), scroll to zoom.

import { createEffect, onCleanup, onMount } from "solid-js";
import type { Deck } from "../state/deck";
import { settings, setSettings } from "../state/settings";
import { HOT_CUE_LETTERS, deckColor } from "./theme";
import { WaveTiles, fitCanvas } from "./wave";
import { displayPos, onFrame } from "./frame";
import { dragLoad } from "./dnd";

export function WaveStrip(p: { decks: Deck[] }) {
  return (
    <div class="wavestrip">
      {p.decks.map((d) => (
        <WaveRow deck={d} />
      ))}
    </div>
  );
}

function WaveRow(p: { deck: Deck }) {
  let canvas!: HTMLCanvasElement;
  let tiles: WaveTiles | null = null;
  const d = p.deck;

  createEffect(() => {
    const w = d.waveform();
    tiles = null;
    if (w && canvas) tiles = new WaveTiles(w, 100, Math.max(40, canvas.height));
  });

  onMount(() => {
    const off = onFrame(() => draw());
    onCleanup(off);
  });

  const draw = () => {
    if (fitCanvas(canvas) && d.waveform()) {
      tiles = new WaveTiles(d.waveform()!, 100, canvas.height);
    }
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width;
    const H = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = "#0b0b10";
    ctx.fillRect(0, 0, W, H);
    const t = d.track();
    const pxPerS = W / settings.waveSeconds;
    const pos = displayPos[d.index];
    const t0 = pos - W / 2 / pxPerS;
    const t1 = t0 + W / pxPerS;
    const x = (time: number) => (time - t0) * pxPerS;

    if (t && tiles) {
      // Loop region.
      if (d.live.loopOn || d.live.loopOut > d.live.loopIn) {
        ctx.fillStyle = d.live.loopOn ? "rgba(255,176,32,0.16)" : "rgba(255,255,255,0.05)";
        ctx.fillRect(x(d.live.loopIn), 0, (d.live.loopOut - d.live.loopIn) * pxPerS, H);
      }
      tiles.draw(ctx, 0, 0, W, H, t0, t1);
      // Dim what has played.
      ctx.fillStyle = "rgba(11,11,16,0.35)";
      ctx.fillRect(0, 0, W / 2, H);
      // Beat grid: bars brighter, with the bar number.
      if (d.hasGrid()) {
        const b0 = Math.floor(d.beatAt(t0));
        const b1 = Math.ceil(d.beatAt(t1));
        const beatPx = d.beat() * pxPerS;
        if (beatPx > 4) {
          for (let b = b0; b <= b1; b++) {
            const bx = Math.round(x(d.timeOfBeat(b))) + 0.5;
            const bar = ((b % 4) + 4) % 4 === 0;
            ctx.fillStyle = bar ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.2)";
            ctx.fillRect(bx, 0, bar ? dpr * 1.5 : dpr, bar ? H : H * 0.12);
            if (!bar) ctx.fillRect(bx, H * 0.88, dpr, H * 0.12);
          }
        }
      }
      // Memory cues, cue point, hot cues.
      for (const m of t.memoryCues) marker(ctx, x(m.time), H, m.color, "", dpr, true);
      marker(ctx, x(d.cuePoint()), H, "#ff9d2e", "", dpr, true);
      t.hotCues.forEach((c, i) => {
        if (c) marker(ctx, x(c.time), H, c.color, HOT_CUE_LETTERS[i], dpr, false);
      });
      if (d.pendingIn() !== null) marker(ctx, x(d.pendingIn()!), H, "#ffb020", "IN", dpr, false);
      // The slip position, a ghost playhead.
      if (d.live.slipping) {
        ctx.fillStyle = "rgba(61,184,255,0.8)";
        ctx.fillRect(x(d.live.slipPos), 0, 2 * dpr, H);
      }
    } else {
      ctx.fillStyle = "#3a3a48";
      ctx.font = `${12 * dpr}px Inter, system-ui, sans-serif`;
      ctx.fillText(d.loading() ?? `Deck ${d.index + 1}: drop a track here`, 12 * dpr, H / 2 + 4 * dpr);
    }
    // Playhead.
    ctx.fillStyle = deckColor(d.index);
    ctx.fillRect(W / 2 - dpr, 0, 2 * dpr, H);
    // Deck number.
    ctx.fillStyle = deckColor(d.index);
    ctx.font = `bold ${11 * dpr}px Inter, system-ui, sans-serif`;
    ctx.fillText(String(d.index + 1), 6 * dpr, 14 * dpr);
  };

  // Drag to scratch (vinyl) or bend (CDJ), like a platter laid flat.
  const down = (e: PointerEvent) => {
    if (!d.track() || e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const scratch = settings.vinyl || !d.live.playing;
    if (scratch) d.scratchStart();
    let lastX = e.clientX;
    let lastT = e.timeStamp;
    let idle: number | undefined;
    const move = (ev: PointerEvent) => {
      const dt = Math.max(1, ev.timeStamp - lastT) / 1000;
      const dx = ev.clientX - lastX;
      lastX = ev.clientX;
      lastT = ev.timeStamp;
      const pxPerS = canvas.clientWidth / settings.waveSeconds;
      const speed = -dx / pxPerS / dt;
      if (scratch) d.scratchSpeed(speed);
      else d.bend(Math.max(-0.3, Math.min(0.3, speed * 0.05)));
      clearTimeout(idle);
      idle = window.setTimeout(() => (scratch ? d.scratchSpeed(0) : d.bend(0)), 40);
    };
    const up = () => {
      clearTimeout(idle);
      if (scratch) d.scratchEnd();
      else d.bend(0);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
    };
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
  };

  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const f = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    setSettings("waveSeconds", Math.max(2, Math.min(60, settings.waveSeconds * f)));
  };

  return (
    <canvas
      class="waverow"
      ref={canvas}
      onPointerDown={down}
      onWheel={wheel}
      {...dragLoad(d)}
    />
  );
}

function marker(
  ctx: CanvasRenderingContext2D,
  x: number,
  H: number,
  color: string,
  label: string,
  dpr: number,
  bottom: boolean,
) {
  if (x < -40 || x > ctx.canvas.width + 40) return;
  ctx.fillStyle = color;
  const s = 6 * dpr;
  ctx.beginPath();
  if (bottom) {
    ctx.moveTo(x - s, H);
    ctx.lineTo(x + s, H);
    ctx.lineTo(x, H - s);
  } else {
    ctx.fillRect(x - dpr / 2, 0, dpr, H);
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 2 * s, 0);
    ctx.lineTo(x + 2 * s, 1.8 * s);
    ctx.lineTo(x, 1.8 * s);
  }
  ctx.fill();
  if (label) {
    ctx.fillStyle = "#0b0b10";
    ctx.font = `bold ${9 * dpr}px Inter, system-ui, sans-serif`;
    ctx.fillText(label, x + 2 * dpr, 1.35 * s);
  }
}
