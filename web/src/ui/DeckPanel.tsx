// One deck: track info and readouts, overview, platter, performance pads, loops,
// tempo, transport.

import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { camelotText, keyColor, keyName } from "../lib/keys";
import type { MusicalKey } from "../lib/types";
import { type Deck, type PadMode, makeMaster } from "../state/deck";
import { artUrl } from "../state/library";
import { settings, setSettings } from "../state/settings";
import { Fader, HoldButton } from "./controls";
import { dragLoad } from "./dnd";
import { displayPos, onFrame } from "./frame";
import { IconEject, IconLeft, IconPause, IconPlay, IconRight } from "./icons";
import { COLORS, HOT_CUE_LETTERS, deckColor } from "./theme";
import { WaveTiles, fitCanvas, formatTime } from "./wave";

const LOOP_PADS = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
const JUMP_PADS = [-1, 1, -2, 2, -4, 4, -8, 8];

function beatsLabel(b: number): string {
  return b === 0.25 ? "1/4" : b === 0.5 ? "1/2" : String(b);
}

export function keyText(k: MusicalKey | undefined): string {
  return settings.keyNotation === "camelot" ? camelotText(k) : keyName(k);
}

export function DeckPanel(p: { deck: Deck; compact?: boolean }) {
  const d = p.deck;
  const [showGrid, setShowGrid] = createSignal(false);
  const [art, setArt] = createSignal<string | null>(null);

  createEffect(() => {
    const t = d.track();
    setArt(null);
    if (t) void artUrl(t).then((u) => d.track()?.id === t.id && setArt(u));
  });

  const tempoPct = () => (d.live.tempo - 1) * 100;
  const duration = () => d.live.duration || d.track()?.duration || 0;
  const atCue = () => Math.abs(d.live.pos - d.cuePoint()) < 0.02;
  const loaded = () => !!d.track();

  return (
    <div class="deck" classList={{ compact: p.compact, empty: !loaded() }} style={{ "--deck": deckColor(d.index) }} {...dragLoad(d)}>
      <div class="deck-head">
        <div class="deck-id">{d.index + 1}</div>
        <div class="deck-art">
          <Show when={art()}>
            <img src={art()!} alt="" />
          </Show>
        </div>
        <div class="deck-meta">
          <div class="title">{d.track()?.title ?? d.loading() ?? "Load a track"}</div>
          <div class="artist">{d.track()?.artist || " "}</div>
        </div>
        <div class="readout key-readout" title="Key as heard">
          <label>KEY</label>
          <span style={{ color: keyColor(d.heardKey()) }}>{keyText(d.heardKey()) || "—"}</span>
          <Show when={d.keyShift() !== 0}>
            <small>
              {d.keyShift() > 0 ? "+" : ""}
              {d.keyShift()}
            </small>
          </Show>
        </div>
        <div class="readout bpm-readout">
          <label>
            BPM
            <Show when={d.master()}>
              <b class="tag master">MASTER</b>
            </Show>
          </label>
          <span>{d.track()?.bpm ? d.currentBpm().toFixed(2) : "--.--"}</span>
        </div>
      </div>

      <div class="deck-status">
        <div class="readout time-readout">
          <label>ELAPSED</label>
          <span>{formatTime(d.live.pos)}</span>
        </div>
        <div class="readout time-readout dim">
          <label>REMAIN</label>
          <span>-{formatTime(duration() - d.live.pos)}</span>
        </div>
        <div class="flags">
          <b classList={{ lit: d.live.loopOn }} class="flag loop">LOOP</b>
          <b classList={{ lit: d.slip() }} class="flag slip">SLIP</b>
          <b classList={{ lit: d.keylock() }} class="flag mt">MT</b>
          <b classList={{ lit: d.sync() }} class="flag sync">SYNC</b>
          <Show when={d.sync() && Math.abs(d.live.phase) > 0.03}>
            <b class="flag lit warn">PHASE</b>
          </Show>
        </div>
        <div class="readout tempo-readout" classList={{ synced: d.sync() }}>
          <label>
            TEMPO
            <button class="range" onClick={() => d.cycleTempoRange()} title="Tempo range">
              ±{d.tempoRange() === 100 ? "WIDE" : d.tempoRange()}
            </button>
          </label>
          <span>
            {tempoPct() >= 0 ? "+" : "−"}
            {Math.abs(tempoPct()).toFixed(2)}%
          </span>
        </div>
      </div>

      <Overview deck={d} />

      <div class="deck-main">
        <Show when={!p.compact}>
          <Jog deck={d} art={art()} />
        </Show>
        <div class="perf">
          <div class="pad-tabs">
            <For each={[["hotcue", "HOT CUE"], ["loop", "BEAT LOOP"], ["jump", "BEAT JUMP"]] as [PadMode, string][]}>
              {([mode, label]) => (
                <button classList={{ on: d.padMode() === mode }} onClick={() => d.setPadMode(mode)}>
                  {label}
                </button>
              )}
            </For>
          </div>
          <div class="pads">
            <Show when={d.padMode() === "hotcue"}>
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
                      title="Click to set or jump · Shift-click or right-click deletes"
                    >
                      <span class="pad-letter">{letter}</span>
                      <Show when={cue()}>
                        <span class="pad-info">{cue()!.name ?? (cue()!.loopEnd !== undefined ? "LOOP" : formatTime(cue()!.time, false))}</span>
                      </Show>
                    </button>
                  );
                }}
              </For>
            </Show>
            <Show when={d.padMode() === "loop"}>
              <For each={LOOP_PADS}>
                {(beats) => (
                  <button
                    class="pad loop-pad"
                    classList={{
                      set: d.live.loopOn && d.beat() > 0 && Math.abs(d.live.loopOut - d.live.loopIn - beats * d.beat()) < 1e-3,
                    }}
                    onClick={() => d.autoLoop(beats)}
                  >
                    <span class="pad-letter">{beatsLabel(beats)}</span>
                  </button>
                )}
              </For>
            </Show>
            <Show when={d.padMode() === "jump"}>
              <For each={JUMP_PADS}>
                {(beats) => (
                  <button class="pad jump-pad" onClick={() => d.beatJump(beats)}>
                    <span class="pad-letter">
                      {beats < 0 ? "◂ " : ""}
                      {Math.abs(beats)}
                      {beats > 0 ? " ▸" : ""}
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </div>
          <div class="loop-row">
            <button classList={{ on: d.pendingIn() !== null }} class="loopbtn" onClick={() => d.loopIn()} title="Loop in">
              IN
            </button>
            <button class="loopbtn" onClick={() => d.loopOut()} title="Loop out">
              OUT
            </button>
            <button classList={{ on: d.live.loopOn }} class="loopbtn" onClick={() => d.reloopExit()} title="Reloop / exit">
              {d.live.loopOn ? "EXIT" : "RELOOP"}
            </button>
            <button onClick={() => d.loopResize(0.5)} title="Halve the loop">
              ½X
            </button>
            <button onClick={() => d.loopResize(2)} title="Double the loop">
              2X
            </button>
            <span class="jump-group">
              <button class="icon" onClick={() => d.beatJump(-d.jumpBeats())} title="Beat jump back">
                <IconLeft />
              </button>
              <select value={d.jumpBeats()} onChange={(e) => d.setJumpBeats(Number(e.currentTarget.value))} title="Beat jump size">
                <For each={[1, 2, 4, 8, 16, 32, 64]}>{(b) => <option value={b}>{b}</option>}</For>
              </select>
              <button class="icon" onClick={() => d.beatJump(d.jumpBeats())} title="Beat jump forward">
                <IconRight />
              </button>
            </span>
          </div>
          <Show when={showGrid() && !p.compact}>
            <div class="grid-row">
              <span class="row-label">GRID</span>
              <button onClick={() => d.gridShift(-5)} title="Move the grid 5 ms earlier">
                −5ms
              </button>
              <button onClick={() => d.gridShift(5)} title="Move the grid 5 ms later">
                +5ms
              </button>
              <button onClick={() => d.gridDownbeatHere()} title="Beat one of the bar is here">
                1 HERE
              </button>
              <button onClick={() => d.gridBpm(-0.01)}>BPM−</button>
              <button onClick={() => d.gridBpm(0.01)}>BPM+</button>
              <button onClick={() => d.gridHalve(0.5)}>÷2</button>
              <button onClick={() => d.gridHalve(2)}>×2</button>
            </div>
          </Show>
        </div>

        <div class="tempo-col">
          <HoldButton class="nudge" onDown={() => d.bend(-0.04)} onUp={() => d.bend(0)} title="Slow down while held">
            −
          </HoldButton>
          <Fader
            vertical
            invert
            value={d.tempoFader()}
            min={-1}
            max={1}
            reset={0}
            length={p.compact ? 60 : 140}
            onChange={(v) => d.setTempoFader(v)}
            title="Tempo (double-click resets)"
            class="tempo-fader"
          >
            <div class="fader-center" />
          </Fader>
          <HoldButton class="nudge" onDown={() => d.bend(0.04)} onUp={() => d.bend(0)} title="Speed up while held">
            +
          </HoldButton>
        </div>
      </div>

      <div class="deck-foot">
        <HoldButton
          class={`transport cue-btn ${loaded() && !d.live.playing ? (atCue() ? "lit" : "blink") : ""}`}
          onDown={() => d.cueDown()}
          onUp={() => d.cueUp()}
          title="Cue"
        >
          CUE
        </HoldButton>
        <button
          class="transport play-btn"
          classList={{ lit: d.live.playing, blink: loaded() && !d.live.playing && atCue() }}
          onClick={() => d.togglePlay()}
          title="Play / pause"
        >
          {d.live.playing ? <IconPause size={16} /> : <IconPlay size={16} />}
        </button>
        <span class="gap" />
        <button class="sync-btn" classList={{ on: d.sync() }} onClick={() => d.setSync(!d.sync())} title="Beat sync">
          SYNC
        </button>
        <button class="master-btn" classList={{ on: d.master() }} onClick={() => makeMaster(d)} title="Tempo master">
          MASTER
        </button>
        <span class="gap" />
        <button class="q-btn" classList={{ on: settings.quantize }} onClick={() => setSettings("quantize", !settings.quantize)} title="Quantize">
          Q
        </button>
        <button class="slip-btn" classList={{ on: d.slip() }} onClick={() => d.setSlip(!d.slip())} title="Slip">
          SLIP
        </button>
        <HoldButton class={d.reverse() ? "on rev-btn" : "rev-btn"} onDown={() => d.setReverse(true)} onUp={() => d.setReverse(false)} title="Reverse while held">
          REV
        </HoldButton>
        <span class="gap" />
        <button class="mt-btn" classList={{ on: d.keylock() }} onClick={() => d.setKeylock(!d.keylock())} title="Master tempo (keylock)">
          MT
        </button>
        <div class="key-shift">
          <button onClick={() => d.setKeyShift(d.keyShift() - 1)} title="Key down a semitone">
            −
          </button>
          <span title="Key shift (double-click resets)" onDblClick={() => d.setKeyShift(0)}>
            {d.keyShift() > 0 ? "+" : ""}
            {d.keyShift()}
          </span>
          <button onClick={() => d.setKeyShift(d.keyShift() + 1)} title="Key up a semitone">
            +
          </button>
        </div>
        <Show when={!p.compact}>
          <button onClick={() => d.keySync()} title="Shift the key to match the master deck">
            KEY SYNC
          </button>
          <span class="grow" />
          <button classList={{ on: showGrid() }} onClick={() => setShowGrid(!showGrid())} title="Edit the beat grid">
            GRID
          </button>
          <button onClick={() => d.addMemoryCue()} title="Add a memory cue here">
            MEMORY
          </button>
        </Show>
        <Show when={p.compact}>
          <span class="grow" />
        </Show>
        <button class="icon" onClick={() => d.eject()} disabled={d.live.playing} title="Eject">
          <IconEject />
        </button>
      </div>
    </div>
  );
}

function Overview(p: { deck: Deck }) {
  const d = p.deck;
  let canvas!: HTMLCanvasElement;
  let painted: HTMLCanvasElement | null = null;
  let paintedFor: unknown = null;

  const paint = () => {
    const w = d.waveform();
    paintedFor = `${settings.waveformStyle}`;
    if (!w) {
      painted = null;
      paintedFor = null;
      return;
    }
    const tiles = new WaveTiles(w, 100, 8, settings.waveformStyle);
    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    tiles.overview(off.getContext("2d")!, off.width, off.height);
    painted = off;
    lastWave = w;
  };
  let lastWave: Uint8Array | null = null;

  onMount(() => {
    const unsub = onFrame(() => {
      if (fitCanvas(canvas) || lastWave !== d.waveform() || paintedFor !== settings.waveformStyle) paint();
      const ctx = canvas.getContext("2d")!;
      const W = canvas.width;
      const H = canvas.height;
      const dpr = window.devicePixelRatio || 1;
      ctx.fillStyle = COLORS.well;
      ctx.fillRect(0, 0, W, H);
      const t = d.track();
      const dur = d.live.duration || t?.duration || 0;
      if (!t || !dur) return;
      if (painted) ctx.drawImage(painted, 0, 0);
      const x = (s: number) => (s / dur) * W;
      const pos = displayPos[d.index];
      // Played part dimmed.
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, x(pos), H);
      if (d.live.loaded < dur - 0.1) {
        ctx.fillStyle = "rgba(0,0,0,0.75)";
        ctx.fillRect(x(d.live.loaded), 0, W - x(d.live.loaded), H);
      }
      // Minute ticks.
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      for (let m = 60; m < dur; m += 60) ctx.fillRect(Math.round(x(m)), H - 4 * dpr, dpr, 4 * dpr);
      if (d.live.loopOut > d.live.loopIn) {
        ctx.fillStyle = d.live.loopOn ? "rgba(126,217,87,0.45)" : "rgba(255,255,255,0.15)";
        ctx.fillRect(x(d.live.loopIn), 0, Math.max(2, x(d.live.loopOut) - x(d.live.loopIn)), H);
      }
      t.memoryCues.forEach((c) => {
        ctx.fillStyle = c.color;
        ctx.fillRect(x(c.time) - dpr, H - 5 * dpr, 2 * dpr, 5 * dpr);
      });
      t.hotCues.forEach((c) => {
        if (!c) return;
        ctx.fillStyle = c.color;
        ctx.fillRect(x(c.time) - dpr, 0, 2 * dpr, 6 * dpr);
      });
      ctx.fillStyle = COLORS.cue;
      ctx.beginPath();
      const cx = x(d.cuePoint());
      ctx.moveTo(cx - 4 * dpr, H);
      ctx.lineTo(cx + 4 * dpr, H);
      ctx.lineTo(cx, H - 5 * dpr);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.fillRect(x(pos) - dpr, 0, 2 * dpr, H);
    });
    onCleanup(unsub);
  });

  const click = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    d.seekFraction((e.clientX - r.left) / r.width);
  };

  return <canvas class="overview" ref={canvas} onPointerDown={click} title="Click to jump" />;
}

/** The platter: drag round it to scratch (vinyl mode) or nudge; the ring shows how
 * far into the track the deck is. */
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

  const OMEGA = ((33 + 1 / 3) / 60) * 2 * Math.PI;

  onMount(() => {
    const unsub = onFrame(() => {
      fitCanvas(canvas);
      const ctx = canvas.getContext("2d")!;
      const W = canvas.width;
      const c = W / 2;
      const dpr = window.devicePixelRatio || 1;
      ctx.clearRect(0, 0, W, W);
      const outer = c - 2 * dpr;
      // Progress ring.
      const dur = d.live.duration || d.track()?.duration || 0;
      const frac = dur ? Math.min(1, displayPos[d.index] / dur) : 0;
      ctx.lineWidth = 4 * dpr;
      ctx.strokeStyle = "#232323";
      ctx.beginPath();
      ctx.arc(c, c, outer - 2 * dpr, 0, Math.PI * 2);
      ctx.stroke();
      if (frac > 0) {
        ctx.strokeStyle = deckColor(d.index);
        ctx.beginPath();
        ctx.arc(c, c, outer - 2 * dpr, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
        ctx.stroke();
      }
      // Platter with fine ridges.
      const plat = outer - 7 * dpr;
      const g = ctx.createRadialGradient(c, c, plat * 0.2, c, c, plat);
      g.addColorStop(0, "#1d1d1d");
      g.addColorStop(1, "#141414");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c, c, plat, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.035)";
      ctx.lineWidth = dpr;
      for (let r = plat * 0.62; r < plat; r += 3 * dpr) {
        ctx.beginPath();
        ctx.arc(c, c, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      const angle = displayPos[d.index] * OMEGA;
      const label = plat * 0.55;
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.arc(0, 0, label, 0, Math.PI * 2);
      ctx.clip();
      if (img) ctx.drawImage(img, -label, -label, label * 2, label * 2);
      else {
        ctx.fillStyle = "#262626";
        ctx.fillRect(-label, -label, label * 2, label * 2);
      }
      ctx.restore();
      // Position marker on the platter edge.
      ctx.save();
      ctx.translate(c, c);
      ctx.rotate(angle);
      ctx.fillStyle = d.live.playing ? "#f2f2f2" : "#9a9a9a";
      ctx.fillRect(-1.5 * dpr, -plat + 2 * dpr, 3 * dpr, plat * 0.32);
      ctx.restore();
      ctx.fillStyle = "#0b0b0b";
      ctx.beginPath();
      ctx.arc(c, c, 4 * dpr, 0, Math.PI * 2);
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
      <button class="vinyl-btn" classList={{ on: settings.vinyl }} onClick={() => setSettings("vinyl", !settings.vinyl)} title="Vinyl mode: touching the platter scratches">
        VINYL
      </button>
    </div>
  );
}
