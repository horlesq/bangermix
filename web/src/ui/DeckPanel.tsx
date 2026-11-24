// One deck: track info, overview, jog wheel, tempo, transport, hot cues and loops.

import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { camelotText, keyColor, keyName } from "../lib/keys";
import type { Deck } from "../state/deck";
import { makeMaster } from "../state/deck";
import { artUrl } from "../state/library";
import { settings, setSettings } from "../state/settings";
import { Fader, HoldButton } from "./controls";
import { dragLoad } from "./dnd";
import { displayPos, onFrame } from "./frame";
import { HOT_CUE_LETTERS, deckColor } from "./theme";
import { WaveTiles, fitCanvas, formatTime } from "./wave";

export function DeckPanel(p: { deck: Deck; compact?: boolean }) {
  const d = p.deck;
  const [showGrid, setShowGrid] = createSignal(false);
  const [art, setArt] = createSignal<string | null>(null);

  createEffect(() => {
    const t = d.track();
    setArt(null);
    if (t) void artUrl(t).then((u) => d.track()?.id === t.id && setArt(u));
  });

  const keyText = () => {
    const k = d.track()?.key;
    return settings.keyNotation === "camelot" ? camelotText(k) : keyName(k);
  };
  const tempoPct = () => (d.live.tempo - 1) * 100;

  return (
    <div class={`deck ${p.compact ? "compact" : ""}`} style={{ "--deck": deckColor(d.index) }} {...dragLoad(d)}>
      <div class="deck-head">
        <div class="deck-num" classList={{ master: d.master() }}>
          {d.index + 1}
        </div>
        <Show when={art()}>
          <img class="deck-art" src={art()!} alt="" />
        </Show>
        <div class="deck-title">
          <div class="title">{d.track()?.title ?? (d.loading() || "No track loaded")}</div>
          <div class="artist">{d.track()?.artist ?? ""}</div>
        </div>
        <div class="deck-key" style={{ color: keyColor(d.track()?.key) }}>
          {keyText()}
        </div>
        <div class="deck-bpm">
          <div class="bpm">{d.track()?.bpm ? d.currentBpm().toFixed(1) : "--.-"}</div>
          <div class="tempo-pct" classList={{ synced: d.sync() }}>
            {tempoPct() >= 0 ? "+" : ""}
            {tempoPct().toFixed(2)}%
            <span class="range" onClick={() => d.cycleTempoRange()} title="Tempo range">
              ±{d.tempoRange() === 100 ? "WIDE" : d.tempoRange()}
            </span>
          </div>
        </div>
      </div>

      <TimeRow deck={d} />
      <Overview deck={d} />

      <div class="deck-body">
        <Show when={!p.compact}>
          <Jog deck={d} art={art()} />
        </Show>
        <div class="deck-controls">
          <div class="row toggles">
            <button class="sync" classList={{ on: d.sync() }} onClick={() => d.setSync(!d.sync())} title="Beat sync">
              SYNC
            </button>
            <button classList={{ on: d.master() }} onClick={() => makeMaster(d)} title="Master tempo for sync">
              MASTER
            </button>
            <button
              classList={{ on: settings.quantize }}
              onClick={() => setSettings("quantize", !settings.quantize)}
              title="Quantize: cues and loops snap to the beat"
            >
              Q
            </button>
            <button classList={{ on: d.slip() }} onClick={() => d.setSlip(!d.slip())} title="Slip">
              SLIP
            </button>
            <HoldButton
              class={d.reverse() ? "on" : ""}
              onDown={() => d.setReverse(true)}
              onUp={() => d.setReverse(false)}
              title="Reverse (hold)"
            >
              REV
            </HoldButton>
            <button classList={{ on: showGrid() }} onClick={() => setShowGrid(!showGrid())} title="Edit the beat grid">
              GRID
            </button>
          </div>

          <Show when={showGrid()}>
            <div class="row grid-edit">
              <button onClick={() => d.gridShift(-5)} title="Move the grid 5 ms earlier">◀ 5ms</button>
              <button onClick={() => d.gridShift(5)} title="Move the grid 5 ms later">5ms ▶</button>
              <button onClick={() => d.gridDownbeatHere()} title="Beat one of the bar is here">1 HERE</button>
              <button onClick={() => d.gridBpm(-0.01)}>BPM −</button>
              <button onClick={() => d.gridBpm(0.01)}>BPM +</button>
              <button onClick={() => d.gridHalve(0.5)}>½</button>
              <button onClick={() => d.gridHalve(2)}>×2</button>
            </div>
          </Show>

          <div class="row hotcues">
            <For each={HOT_CUE_LETTERS}>
              {(letter, i) => {
                const cue = () => d.track()?.hotCues[i()] ?? null;
                return (
                  <button
                    class="pad"
                    classList={{ set: !!cue() }}
                    style={cue() ? { "--pad": cue()!.color } : {}}
                    onClick={(e) => (e.shiftKey ? d.deleteHotCue(i()) : d.hotCue(i()))}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      d.deleteHotCue(i());
                    }}
                    title="Hot cue: click to set or jump, Shift-click or right-click to delete"
                  >
                    {letter}
                  </button>
                );
              }}
            </For>
          </div>

          <div class="row loops">
            <For each={[0.5, 1, 2, 4, 8, 16]}>
              {(beats) => (
                <button
                  classList={{
                    on:
                      d.live.loopOn &&
                      d.beat() > 0 &&
                      Math.abs(d.live.loopOut - d.live.loopIn - beats * d.beat()) < 1e-3,
                  }}
                  onClick={() => d.autoLoop(beats)}
                  title={`${beats}-beat loop`}
                >
                  {beats === 0.5 ? "½" : beats}
                </button>
              )}
            </For>
            <span class="sep" />
            <button classList={{ on: d.pendingIn() !== null }} onClick={() => d.loopIn()}>IN</button>
            <button onClick={() => d.loopOut()}>OUT</button>
            <button classList={{ on: d.live.loopOn }} onClick={() => d.reloopExit()} title="Reloop / exit">
              {d.live.loopOn ? "EXIT" : "RELOOP"}
            </button>
            <button onClick={() => d.loopResize(0.5)} title="Halve the loop">½×</button>
            <button onClick={() => d.loopResize(2)} title="Double the loop">2×</button>
          </div>

          <div class="row jump">
            <button onClick={() => d.beatJump(-d.jumpBeats())} title="Beat jump back">◀◀</button>
            <select
              value={d.jumpBeats()}
              onChange={(e) => d.setJumpBeats(Number(e.currentTarget.value))}
              title="Beats to jump"
            >
              <For each={[1, 2, 4, 8, 16, 32, 64]}>{(b) => <option value={b}>{b} beats</option>}</For>
            </select>
            <button onClick={() => d.beatJump(d.jumpBeats())} title="Beat jump forward">▶▶</button>
            <span class="sep" />
            <button onClick={() => d.addMemoryCue()} title="Add a memory cue">MEMORY</button>
            <button onClick={() => d.eject()} disabled={d.live.playing} title="Eject">⏏</button>
          </div>

          <div class="row transport">
            <HoldButton class="cue-btn" onDown={() => d.cueDown()} onUp={() => d.cueUp()} title="Cue">
              CUE
            </HoldButton>
            <button class="play-btn" classList={{ on: d.live.playing }} onClick={() => d.togglePlay()} title="Play / pause">
              {d.live.playing ? "❚❚" : "▶"}
            </button>
          </div>
        </div>

        <div class="tempo-col">
          <HoldButton class="bend" onDown={() => d.bend(-0.04)} onUp={() => d.bend(0)} title="Slow down while held">
            −
          </HoldButton>
          <Fader
            vertical
            invert
            value={d.tempoFader()}
            min={-1}
            max={1}
            reset={0}
            length={p.compact ? 90 : 150}
            onChange={(v) => d.setTempoFader(v)}
            title="Tempo (double-click to reset)"
            class="tempo-fader"
          >
            <div class="fader-center" />
          </Fader>
          <HoldButton class="bend" onDown={() => d.bend(0.04)} onUp={() => d.bend(0)} title="Speed up while held">
            +
          </HoldButton>
        </div>
      </div>
    </div>
  );
}

function TimeRow(p: { deck: Deck }) {
  const d = p.deck;
  const duration = () => d.live.duration || d.track()?.duration || 0;
  return (
    <div class="time-row">
      <span class="elapsed">{formatTime(d.live.pos)}</span>
      <span class="remain">-{formatTime(duration() - d.live.pos)}</span>
      <Show when={d.sync() && Math.abs(d.live.phase) > 0.02}>
        <span class="phase">phase {(d.live.phase * 100).toFixed(0)}%</span>
      </Show>
      <Show when={d.live.loopOn}>
        <span class="loop-badge">LOOP</span>
      </Show>
    </div>
  );
}

function Overview(p: { deck: Deck }) {
  const d = p.deck;
  let canvas!: HTMLCanvasElement;
  let painted: HTMLCanvasElement | null = null;
  let paintedFor: Uint8Array | null = null;

  const paint = () => {
    const w = d.waveform();
    if (!w) {
      painted = null;
      return;
    }
    const tiles = new WaveTiles(w, 100, 8);
    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    tiles.overview(off.getContext("2d")!, off.width, off.height);
    painted = off;
    paintedFor = w;
  };

  onMount(() => {
    const unsub = onFrame(() => {
      if (fitCanvas(canvas) || paintedFor !== d.waveform()) paint();
      const ctx = canvas.getContext("2d")!;
      const W = canvas.width;
      const H = canvas.height;
      ctx.fillStyle = "#0b0b10";
      ctx.fillRect(0, 0, W, H);
      const t = d.track();
      const dur = d.live.duration || t?.duration || 0;
      if (!t || !dur) return;
      if (painted) ctx.drawImage(painted, 0, 0);
      const x = (s: number) => (s / dur) * W;
      const pos = displayPos[d.index];
      ctx.fillStyle = "rgba(11,11,16,0.55)";
      ctx.fillRect(0, 0, x(pos), H);
      // Not decoded yet.
      if (d.live.loaded < dur - 0.1) {
        ctx.fillStyle = "rgba(11,11,16,0.7)";
        ctx.fillRect(x(d.live.loaded), 0, W - x(d.live.loaded), H);
      }
      if (d.live.loopOut > d.live.loopIn) {
        ctx.fillStyle = d.live.loopOn ? "rgba(255,176,32,0.35)" : "rgba(255,255,255,0.12)";
        ctx.fillRect(x(d.live.loopIn), 0, Math.max(2, x(d.live.loopOut) - x(d.live.loopIn)), H);
      }
      t.hotCues.forEach((c) => {
        if (!c) return;
        ctx.fillStyle = c.color;
        ctx.fillRect(x(c.time) - 1, 0, 2, H * 0.35);
      });
      ctx.fillStyle = "#ff9d2e";
      ctx.fillRect(x(d.cuePoint()) - 1, H * 0.65, 2, H * 0.35);
      ctx.fillStyle = "#fff";
      ctx.fillRect(x(pos) - 1, 0, 2, H);
    });
    onCleanup(unsub);
  });

  const click = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    d.seekFraction((e.clientX - r.left) / r.width);
  };

  return <canvas class="overview" ref={canvas} onPointerDown={click} title="Click to jump" />;
}

/** The jog wheel: drag round it to scratch (vinyl mode) or nudge (CDJ mode). */
function Jog(p: { deck: Deck; art: string | null }) {
  const d = p.deck;
  let canvas!: HTMLCanvasElement;
  let img: HTMLImageElement | null = null;

  createEffect(() => {
    const src = p.art;
    img = null;
    if (src) {
      const i = new Image();
      i.onload = () => (img = i);
      i.src = src;
    }
  });

  const RPM = 33 + 1 / 3;
  const OMEGA = (RPM / 60) * 2 * Math.PI;

  onMount(() => {
    const unsub = onFrame(() => {
      fitCanvas(canvas);
      const ctx = canvas.getContext("2d")!;
      const W = canvas.width;
      const c = W / 2;
      const r = c - 3;
      ctx.clearRect(0, 0, W, W);
      ctx.fillStyle = "#15151d";
      ctx.beginPath();
      ctx.arc(c, c, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(2, W * 0.02);
      ctx.strokeStyle = d.live.playing ? deckColor(d.index) : "#2a2a36";
      ctx.stroke();
      const angle = displayPos[d.index] * OMEGA;
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(angle);
      const inner = r * 0.55;
      ctx.beginPath();
      ctx.arc(0, 0, inner, 0, Math.PI * 2);
      ctx.clip();
      if (img) {
        ctx.drawImage(img, -inner, -inner, inner * 2, inner * 2);
      } else {
        ctx.fillStyle = "#1e1e28";
        ctx.fillRect(-inner, -inner, inner * 2, inner * 2);
      }
      ctx.restore();
      // The position marker.
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(angle);
      ctx.fillStyle = "#fff";
      ctx.fillRect(-W * 0.012, -r + 2, W * 0.024, r * 0.3);
      ctx.restore();
      ctx.fillStyle = "#0b0b10";
      ctx.beginPath();
      ctx.arc(c, c, W * 0.04, 0, Math.PI * 2);
      ctx.fill();
    });
    onCleanup(unsub);
  });

  const down = (e: PointerEvent) => {
    if (!d.track() || e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const angleOf = (ev: PointerEvent) => Math.atan2(ev.clientY - cy, ev.clientX - cx);
    // Vinyl mode scratches from the top of the platter; the outer edge always bends.
    const fromCentre = Math.hypot(e.clientX - cx, e.clientY - cy) / (rect.width / 2);
    const scratch = !d.live.playing || (settings.vinyl && fromCentre < 0.8);
    if (scratch) d.scratchStart();
    let last = angleOf(e);
    let lastT = e.timeStamp;
    let idle: number | undefined;
    const move = (ev: PointerEvent) => {
      const a = angleOf(ev);
      let da = a - last;
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      last = a;
      const dt = Math.max(1, ev.timeStamp - lastT) / 1000;
      lastT = ev.timeStamp;
      const speed = da / dt / OMEGA;
      if (scratch) d.scratchSpeed(speed);
      else d.bend(Math.max(-0.5, Math.min(0.5, speed * 0.15)));
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

  return (
    <div class="jog-wrap">
      <canvas class="jog" ref={canvas} onPointerDown={down} />
      <button
        class="vinyl-btn"
        classList={{ on: settings.vinyl }}
        onClick={() => setSettings("vinyl", !settings.vinyl)}
        title="Vinyl mode: touching the platter scratches"
      >
        VINYL
      </button>
    </div>
  );
}
