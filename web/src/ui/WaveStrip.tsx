// The scrolling waveforms of every deck, stacked, playhead in the middle. Drag one to
// scratch (or nudge, with vinyl mode off), scroll to zoom.

import { createEffect, onCleanup, onMount } from "solid-js";
import type { Deck } from "../state/deck";
import { settings, setSettings } from "../state/settings";
import { dragLoad } from "./dnd";
import { displayPos, onFrame } from "./frame";
import { COLORS, HOT_CUE_LETTERS, deckColor } from "./theme";
import { WaveTiles, fitCanvas, formatTime } from "./wave";

export function WaveStrip(p: { decks: Deck[] }) {
  return (
    <div class="wavestrip" classList={{ four: p.decks.length > 2 }}>
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

  const build = () => {
    const w = d.waveform();
    tiles = w && canvas.height > 1 ? new WaveTiles(w, 100, canvas.height, settings.waveformStyle) : null;
  };
  createEffect(() => {
    d.waveform();
    void settings.waveformStyle;
    if (canvas) build();
  });

  onMount(() => onCleanup(onFrame(() => draw())));

  const draw = () => {
    if (fitCanvas(canvas)) build();
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width;
    const H = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = COLORS.well;
    ctx.fillRect(0, 0, W, H);
    // A faint centre line, like a scope.
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    ctx.fillRect(0, Math.floor(H / 2), W, dpr);
    const t = d.track();
    // Each deck is drawn at the tempo it plays at, so the same stretch of screen is
    // the same time on every deck and synced beat grids line up edge to edge.
    const pxPerS = W / settings.waveSeconds / (t ? d.live.tempo || 1 : 1);
    const pos = displayPos[d.index];
    const t0 = pos - W / 2 / pxPerS;
    const t1 = t0 + W / pxPerS;
    const x = (time: number) => (time - t0) * pxPerS;

    if (t && tiles) {
      if (d.live.loopOut > d.live.loopIn) {
        ctx.fillStyle = d.live.loopOn ? COLORS.loopOn : COLORS.loopOff;
        ctx.fillRect(x(d.live.loopIn), 0, (d.live.loopOut - d.live.loopIn) * pxPerS, H);
      }
      tiles.draw(ctx, 0, 0, W, H, t0, t1);
      if (d.hasGrid()) {
        const beatPx = d.beat() * pxPerS;
        if (beatPx > 5) {
          for (let b = Math.floor(d.beatAt(t0)); b <= Math.ceil(d.beatAt(t1)); b++) {
            const bx = Math.round(x(d.timeOfBeat(b)));
            const bar = ((b % 4) + 4) % 4 === 0;
            ctx.fillStyle = bar ? COLORS.bar : COLORS.grid;
            ctx.fillRect(bx, 0, dpr, H);
            if (bar) {
              // Downbeat tabs top and bottom.
              ctx.fillRect(bx, 0, 3 * dpr, 3 * dpr);
              ctx.fillRect(bx, H - 3 * dpr, 3 * dpr, 3 * dpr);
            }
          }
        }
      }
      for (const m of t.memoryCues) tab(ctx, x(m.time), H, m.color, "", dpr, true);
      tab(ctx, x(d.cuePoint()), H, COLORS.cue, "", dpr, true);
      t.hotCues.forEach((c, i) => c && tab(ctx, x(c.time), H, c.color, HOT_CUE_LETTERS[i], dpr, false));
      if (d.pendingIn() !== null) tab(ctx, x(d.pendingIn()!), H, "#7ed957", "IN", dpr, false);
      if (d.live.slipping) {
        ctx.fillStyle = COLORS.slip;
        ctx.fillRect(x(d.live.slipPos) - dpr, 0, 2 * dpr, H);
      }
    }

    // Playhead.
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(W / 2 - 2 * dpr, 0, 4 * dpr, H);
    ctx.fillStyle = COLORS.playhead;
    ctx.fillRect(W / 2 - dpr, 0, 2 * dpr, H);

    // Deck info, top left: number, bar.beat, remaining time.
    const f = (px: number, weight = 600) => `${weight} ${px * dpr}px "Segoe UI", Arial, sans-serif`;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(0, 0, 118 * dpr, 16 * dpr);
    ctx.fillStyle = deckColor(d.index);
    ctx.fillRect(0, 0, 16 * dpr, 16 * dpr);
    ctx.fillStyle = "#000";
    ctx.font = f(11, 700);
    ctx.fillText(String(d.index + 1), 4.5 * dpr, 12 * dpr);
    ctx.font = f(10);
    if (t) {
      let barText = "";
      if (d.hasGrid()) {
        const beat = Math.floor(d.beatAt(d.live.pos) + 1e-6);
        const bar = Math.floor(beat / 4) + 1;
        barText = `${bar}.${(((beat % 4) + 4) % 4) + 1}`;
      }
      const dur = d.live.duration || t.duration || 0;
      ctx.fillStyle = COLORS.text;
      ctx.fillText(barText, 22 * dpr, 12 * dpr);
      ctx.fillStyle = COLORS.dim;
      ctx.fillText(`-${formatTime(dur - d.live.pos, false)}`, 66 * dpr, 12 * dpr);
    } else {
      ctx.fillStyle = COLORS.dim;
      ctx.fillText(d.loading() ?? "Empty", 22 * dpr, 12 * dpr);
    }
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
      const pxPerTrackS = canvas.clientWidth / settings.waveSeconds / (d.live.tempo || 1);
      const speed = -dx / pxPerTrackS / dt;
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

  return <canvas class="waverow" ref={canvas} onPointerDown={down} onWheel={wheel} {...dragLoad(d)} />;
}

/** A cue marker: a flag with a letter at the top (hot cues) or a triangle at the
 * bottom (cue point, memory cues). */
function tab(ctx: CanvasRenderingContext2D, x: number, H: number, color: string, label: string, dpr: number, bottom: boolean) {
  if (x < -40 || x > ctx.canvas.width + 40) return;
  ctx.fillStyle = color;
  const s = 5 * dpr;
  ctx.beginPath();
  if (bottom) {
    ctx.moveTo(x - s, H);
    ctx.lineTo(x + s, H);
    ctx.lineTo(x, H - s * 1.2);
    ctx.fill();
    return;
  }
  ctx.fillRect(x, 0, dpr, H);
  ctx.fillRect(x, 0, 12 * dpr, 11 * dpr);
  if (label) {
    ctx.fillStyle = "#000";
    ctx.font = `700 ${9 * dpr}px "Segoe UI", Arial, sans-serif`;
    ctx.fillText(label, x + 3 * dpr, 9 * dpr);
  }
}
