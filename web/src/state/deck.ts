// A deck as the player sees it: transport, cues, loops, sync, tempo, grid edits.
// The audio itself runs in the engine; this decides what to tell it.

import { batch, createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { P, S } from "../audio/params";
import { shiftToMatch, transpose } from "../lib/keys";
import { HOT_CUE_COLORS, type Cue, type MusicalKey, type TrackRec } from "../lib/types";
import { engine, maybeEngine, notify, pool } from "./app";
import {
  WAVEFORM_COLUMNS_PER_S,
  fileFor,
  needsAnalysis,
  onTrackChange,
  storeAnalysis,
  trackById,
  updateTrack,
  waveformFor,
} from "./library";
import { settings } from "./settings";

export interface Live {
  pos: number;
  playing: boolean;
  speed: number;
  tempo: number;
  loopOn: boolean;
  loopIn: number;
  loopOut: number;
  slipping: boolean;
  slipPos: number;
  loaded: number;
  duration: number;
  phase: number;
  pitch: number;
}

export class Deck {
  readonly index: number;
  readonly track: () => TrackRec | null;
  private readonly setTrack: (t: TrackRec | null) => void;
  readonly waveform: () => Uint8Array | null;
  private readonly setWaveform: (w: Uint8Array | null) => void;
  readonly loading: () => string | null;
  private readonly setLoading: (s: string | null) => void;
  readonly live: Live;
  private readonly setLive: (k: keyof Live, v: number | boolean) => void;
  readonly tempoFader: () => number;
  private readonly setTempoFaderSig: (v: number) => void;
  readonly tempoRange: () => number;
  readonly setTempoRange: (v: number) => void;
  readonly sync: () => boolean;
  private readonly setSyncSig: (v: boolean) => void;
  readonly master: () => boolean;
  private readonly setMasterSig: (v: boolean) => void;
  readonly slip: () => boolean;
  private readonly setSlipSig: (v: boolean) => void;
  readonly reverse: () => boolean;
  private readonly setReverseSig: (v: boolean) => void;
  readonly cuePoint: () => number;
  private readonly setCuePoint: (v: number) => void;
  /** Loop in set with IN, waiting for OUT. */
  readonly pendingIn: () => number | null;
  private readonly setPendingIn: (v: number | null) => void;
  readonly jumpBeats: () => number;
  readonly setJumpBeats: (v: number) => void;
  readonly keylock: () => boolean;
  private readonly setKeylockSig: (v: boolean) => void;
  readonly keyShift: () => number;
  private readonly setKeyShiftSig: (v: number) => void;
  /** Which set of actions the 8 pads play. */
  readonly padMode: () => PadMode;
  readonly setPadMode: (m: PadMode) => void;

  private previewing = false;
  private loadToken = 0;
  private tempo = 1;

  constructor(index: number) {
    this.index = index;
    [this.track, this.setTrack] = createSignal<TrackRec | null>(null, { equals: false });
    [this.waveform, this.setWaveform] = createSignal<Uint8Array | null>(null);
    [this.loading, this.setLoading] = createSignal<string | null>(null);
    const [live, setLive] = createStore<Live>({
      pos: 0,
      playing: false,
      speed: 0,
      tempo: 1,
      loopOn: false,
      loopIn: 0,
      loopOut: 0,
      slipping: false,
      slipPos: 0,
      loaded: 0,
      duration: 0,
      phase: 0,
      pitch: 1,
    });
    this.live = live;
    this.setLive = setLive as any;
    [this.tempoFader, this.setTempoFaderSig] = createSignal(0);
    [this.tempoRange, this.setTempoRange] = createSignal(settings.tempoRange);
    [this.sync, this.setSyncSig] = createSignal(false);
    [this.master, this.setMasterSig] = createSignal(false);
    [this.slip, this.setSlipSig] = createSignal(false);
    [this.reverse, this.setReverseSig] = createSignal(false);
    [this.cuePoint, this.setCuePoint] = createSignal(0);
    [this.pendingIn, this.setPendingIn] = createSignal<number | null>(null);
    [this.jumpBeats, this.setJumpBeats] = createSignal(settings.beatJump);
    [this.keylock, this.setKeylockSig] = createSignal(settings.keylockDefault);
    [this.keyShift, this.setKeyShiftSig] = createSignal(0);
    [this.padMode, this.setPadMode] = createSignal<PadMode>("hotcue");

    onTrackChange((t) => {
      if (t.id === this.track()?.id) {
        this.setTrack(t);
        this.sendGrid();
      }
    });
  }

  private set(param: number, value: number) {
    maybeEngine()?.set(this.index, param, value);
  }

  // --- Reading the engine -------------------------------------------------------

  /** Copies the engine's view of the deck into reactive state (once per frame). */
  poll() {
    const e = maybeEngine();
    if (!e) return;
    const d = (v: number) => e.deck(this.index, v);
    batch(() => {
      this.setLive("pos", d(S.POS));
      this.setLive("playing", d(S.PLAYING) > 0.5);
      this.setLive("speed", d(S.SPEED));
      this.setLive("tempo", d(S.TEMPO));
      this.setLive("loopOn", d(S.LOOP_ON) > 0.5);
      this.setLive("loopIn", d(S.LOOP_IN));
      this.setLive("loopOut", d(S.LOOP_OUT));
      this.setLive("slipping", d(S.SLIPPING) > 0.5);
      this.setLive("slipPos", d(S.SLIP_POS));
      this.setLive("loaded", d(S.LOADED));
      this.setLive("duration", d(S.DURATION));
      this.setLive("phase", d(S.PHASE));
      this.setLive("pitch", d(S.PITCH) || 1);
    });
  }

  peakL(): number {
    return maybeEngine()?.deck(this.index, S.PEAK_L) ?? 0;
  }

  peakR(): number {
    return maybeEngine()?.deck(this.index, S.PEAK_R) ?? 0;
  }

  /** Where the deck is heard right now (the engine's position less output latency). */
  heardPos(): number {
    const e = maybeEngine();
    if (!e) return 0;
    return e.deck(this.index, S.POS) - e.deck(this.index, S.SPEED) * e.latency;
  }

  // --- Grid ---------------------------------------------------------------------

  bpm(): number {
    return this.track()?.bpm ?? 0;
  }

  beat(): number {
    const b = this.bpm();
    return b > 0 ? 60 / b : 0;
  }

  hasGrid(): boolean {
    return this.beat() > 0 && !!this.track();
  }

  /** BPM as heard, after the tempo fader or sync. */
  currentBpm(): number {
    return this.bpm() * this.live.tempo;
  }

  private anchor(): number {
    return this.track()?.anchor ?? 0;
  }

  /** Beat index (fractional) at time `t`. */
  beatAt(t: number): number {
    return (t - this.anchor()) / this.beat();
  }

  timeOfBeat(b: number): number {
    return this.anchor() + b * this.beat();
  }

  /** The nearest beat to `t` when quantize is on and there is a grid. */
  quant(t: number): number {
    if (!settings.quantize || !this.hasGrid()) return t;
    return this.timeOfBeat(Math.round(this.beatAt(t)));
  }

  /** The beat at or before `t`, when quantizing. */
  quantDown(t: number): number {
    if (!settings.quantize || !this.hasGrid()) return t;
    return this.timeOfBeat(Math.floor(this.beatAt(t) + 0.02));
  }

  private sendGrid() {
    const t = this.track();
    this.set(P.BEAT, t && t.bpm ? 60 / t.bpm : 0);
    this.set(P.ANCHOR, t?.anchor ?? 0);
  }

  private firstBeat(): number {
    if (!this.hasGrid()) return 0;
    const b = this.beat();
    let t = this.anchor();
    while (t < 0) t += b;
    while (t - b >= 0) t -= b;
    return t;
  }

  // --- Loading ------------------------------------------------------------------

  async load(t: TrackRec) {
    if (this.live.playing) {
      notify(`Deck ${this.index + 1} is playing: pause it to load a track.`);
      return;
    }
    const token = ++this.loadToken;
    this.setLoading("Loading…");
    try {
      const file = await fileFor(t);
      const bytes = await file.arrayBuffer();
      const analyse = needsAnalysis(t);
      if (analyse) this.setLoading("Loading and analysing…");
      const r = await pool.run(
        {
          op: "decode",
          analyse,
          bytes,
          ext: t.ext,
          bpmRange: [settings.bpmMin, settings.bpmMax],
          columnsPerS: WAVEFORM_COLUMNS_PER_S,
        },
        "high",
      );
      if (token !== this.loadToken) return;
      if (r.analysis && r.waveform) await storeAnalysis(t.id, r.analysis, r.waveform);
      const fresh = trackById(t.id) ?? t;
      const waveform = r.waveform ?? (await waveformFor(t.id)) ?? null;
      if (token !== this.loadToken) return;
      void engine().load(this.index, r.left!, r.right!, r.rate!);
      batch(() => {
        this.setTrack(fresh);
        this.setWaveform(waveform);
        this.setPendingIn(null);
        this.previewing = false;
        this.setReverseSig(false);
      });
      this.sendGrid();
      this.set(P.KEYLOCK, this.keylock() ? 1 : 0);
      this.setKeyShift(0);
      const cue = fresh.cue ?? this.firstBeat();
      this.setCuePoint(cue);
      this.set(P.SEEK, cue);
      if (this.slip()) this.set(P.SLIP, 1);
      updateTrack(fresh.id, { playCount: fresh.playCount + 1, lastPlayed: Date.now() });
      onDeckLoaded(this);
    } catch (e) {
      if (token === this.loadToken) notify(`Could not load ${t.title}: ${(e as Error).message}`);
    } finally {
      if (token === this.loadToken) this.setLoading(null);
    }
  }

  eject() {
    if (this.live.playing) return;
    this.loadToken++;
    maybeEngine()?.unload(this.index);
    this.setTrack(null);
    this.setWaveform(null);
  }

  // --- Transport ----------------------------------------------------------------

  togglePlay() {
    if (!this.track()) return;
    this.previewing = false;
    this.set(P.PLAY, this.live.playing ? 0 : 1);
  }

  play(on: boolean) {
    if (!this.track()) return;
    this.previewing = false;
    this.set(P.PLAY, on ? 1 : 0);
  }

  /** CUE as on a CDJ: while playing, back to the cue point and stop; while stopped
   * elsewhere, set the cue point here; at the cue point, play while held. */
  cueDown() {
    if (!this.track()) return;
    const pos = this.live.pos;
    if (this.live.playing && !this.previewing) {
      this.set(P.PLAY, 0);
      this.set(P.SEEK, this.cuePoint());
    } else if (Math.abs(pos - this.cuePoint()) > 0.02) {
      const at = this.quant(pos);
      this.setCuePoint(at);
      this.set(P.SEEK, at);
      updateTrack(this.track()!.id, { cue: at });
    } else {
      this.previewing = true;
      this.set(P.PLAY, 1);
    }
  }

  cueUp() {
    if (this.previewing) {
      this.previewing = false;
      this.set(P.PLAY, 0);
      this.set(P.SEEK, this.cuePoint());
    }
  }

  seek(t: number) {
    if (!this.track()) return;
    this.set(P.SEEK, Math.max(0, t));
  }

  /** A jump to anywhere (overview click). A synced deck lands back in step with the
   * master's bars; beat jumps and hot cues keep their place in the bar instead. */
  seekFraction(f: number) {
    const d = this.live.duration || this.track()?.duration || 0;
    this.seek(this.quant(f * d));
    if (this.sync()) this.set(P.ALIGN, 1);
  }

  /** A jump that keeps the beat: lands as far from `t` as the deck now is from its
   * nearest beat. */
  private jumpKeepingPhase(t: number) {
    if (this.live.playing && settings.quantize && this.hasGrid()) {
      const pos = this.live.pos;
      const off = pos - this.timeOfBeat(Math.round(this.beatAt(pos)));
      this.seek(t + off);
    } else {
      this.seek(t);
    }
  }

  hotCue(i: number) {
    const t = this.track();
    if (!t) return;
    const cue = t.hotCues[i];
    if (cue) {
      this.jumpKeepingPhase(cue.time);
      if (cue.loopEnd !== undefined) this.setLoop(cue.time, cue.loopEnd);
      if (!this.live.playing) this.set(P.PLAY, 1);
    } else {
      const at = this.quant(this.live.pos);
      const hotCues = [...t.hotCues];
      hotCues[i] = { time: at, color: HOT_CUE_COLORS[i % HOT_CUE_COLORS.length] };
      if (this.live.loopOn) hotCues[i]!.loopEnd = this.live.loopOut;
      updateTrack(t.id, { hotCues });
    }
  }

  deleteHotCue(i: number) {
    const t = this.track();
    if (!t) return;
    const hotCues = [...t.hotCues];
    hotCues[i] = null;
    updateTrack(t.id, { hotCues });
  }

  addMemoryCue() {
    const t = this.track();
    if (!t) return;
    const cue: Cue = { time: this.quant(this.live.pos), color: "#ff3d3d" };
    updateTrack(t.id, { memoryCues: [...t.memoryCues, cue].sort((a, b) => a.time - b.time) });
  }

  beatJump(beats: number) {
    const b = this.beat();
    const dt = b > 0 ? beats * b : beats * 0.5;
    if (this.live.loopOn) this.setLoop(this.live.loopIn + dt, this.live.loopOut + dt);
    this.seek(this.live.pos + dt);
  }

  // --- Loops --------------------------------------------------------------------

  private setLoop(a: number, b: number) {
    this.set(P.LOOP_IN, a);
    this.set(P.LOOP_OUT, b);
    this.set(P.LOOP_ON, 1);
  }

  autoLoop(beats: number) {
    if (!this.track()) return;
    const b = this.beat() || 0.5;
    const len = beats * b;
    if (this.live.loopOn && Math.abs(this.live.loopOut - this.live.loopIn - len) < 1e-3) {
      this.set(P.LOOP_ON, 0);
      return;
    }
    const start = this.live.loopOn ? this.live.loopIn : this.quantDown(this.live.pos);
    this.setLoop(start, start + len);
  }

  loopIn() {
    if (!this.track()) return;
    this.setPendingIn(this.quant(this.live.pos));
  }

  loopOut() {
    const a = this.pendingIn() ?? (this.live.loopOn ? this.live.loopIn : null);
    if (a === null) return;
    const b = this.quant(this.live.pos);
    if (b <= a + 0.01) return;
    this.setLoop(a, b);
    this.setPendingIn(null);
  }

  reloopExit() {
    if (this.live.loopOn) {
      this.set(P.LOOP_ON, 0);
    } else if (this.live.loopOut > this.live.loopIn) {
      this.seek(this.live.loopIn);
      this.set(P.LOOP_ON, 1);
    }
  }

  loopResize(factor: number) {
    if (this.live.loopOut <= this.live.loopIn) return;
    const len = (this.live.loopOut - this.live.loopIn) * factor;
    if (len < 0.01 || len > 120) return;
    this.set(P.LOOP_OUT, this.live.loopIn + len);
    if (!this.live.loopOn) return;
    this.set(P.LOOP_ON, 1);
  }

  // --- Tempo, sync, bend --------------------------------------------------------

  /** Tempo fader, -1 (slowest) to 1 (fastest). */
  setTempoFader(v: number) {
    const f = Math.max(-1, Math.min(1, v));
    this.setTempoFaderSig(f);
    this.tempo = 1 + (f * this.tempoRange()) / 100;
    this.set(P.TEMPO, this.tempo);
  }

  resetTempo() {
    this.setTempoFader(0);
  }

  cycleTempoRange() {
    const ranges = [6, 10, 16, 100];
    const next = ranges[(ranges.indexOf(this.tempoRange()) + 1) % ranges.length];
    const tempo = this.tempo;
    this.setTempoRange(next);
    // Keep the tempo; the fader moves.
    this.setTempoFader(((tempo - 1) * 100) / next);
  }

  bend(amount: number) {
    this.set(P.BEND, amount);
  }

  setSync(on: boolean) {
    if (!on && this.sync()) {
      // Stay at the synced tempo rather than jump back to the fader's.
      const tempo = this.live.tempo;
      this.setTempoFader(((tempo - 1) * 100) / this.tempoRange());
    }
    this.setSyncSig(on);
    this.set(P.SYNC, on ? 1 : 0);
    if (on) onSyncEngaged(this);
  }

  setMaster(on: boolean) {
    this.setMasterSig(on);
    this.set(P.MASTER, on ? 1 : 0);
  }

  setSlip(on: boolean) {
    this.setSlipSig(on);
    this.set(P.SLIP, on ? 1 : 0);
  }

  setKeylock(on: boolean) {
    this.setKeylockSig(on);
    this.set(P.KEYLOCK, on ? 1 : 0);
  }

  setKeyShift(semitones: number) {
    const s = Math.max(-12, Math.min(12, Math.round(semitones)));
    this.setKeyShiftSig(s);
    this.set(P.KEY_SHIFT, s);
  }

  /** The key as heard: shifted by the key shift, and by the tempo without keylock. */
  heardKey(): MusicalKey | undefined {
    const k = this.track()?.key;
    if (!k) return undefined;
    const pitch = this.live.playing ? this.live.pitch : this.keylock() ? 2 ** (this.keyShift() / 12) : this.live.tempo * 2 ** (this.keyShift() / 12);
    return transpose(k, 12 * Math.log2(pitch || 1));
  }

  /** Shifts the key to match the master deck's (with keylock, so tempo can't undo it). */
  keySync() {
    const m = masterDeck();
    const mine = this.track()?.key;
    const theirs = m && m !== this ? m.heardKey() : undefined;
    if (!mine || !theirs) return;
    this.setKeylock(true);
    this.setKeyShift(shiftToMatch(mine, theirs));
  }

  setReverse(on: boolean) {
    this.setReverseSig(on);
    this.set(P.REVERSE, on ? 1 : 0);
  }

  // --- Platter: scratching and jog ----------------------------------------------

  scratchStart() {
    if (!this.track()) return;
    this.set(P.SCRATCH, 1);
  }

  /** Platter speed while held, 1 = normal. */
  scratchSpeed(speed: number) {
    this.set(P.SCRATCH_SPEED, speed);
  }

  scratchEnd() {
    this.set(P.SCRATCH, 0);
  }

  // --- Grid edits ---------------------------------------------------------------

  /** Moves the grid by `ms` milliseconds. */
  gridShift(ms: number) {
    const t = this.track();
    if (!t?.bpm) return;
    updateTrack(t.id, { anchor: (t.anchor ?? 0) + ms / 1000, analysisVersion: -1 });
  }

  /** Makes the beat nearest the playhead beat one of a bar. */
  gridDownbeatHere() {
    const t = this.track();
    if (!t?.bpm) return;
    const pos = this.live.pos;
    const near = this.timeOfBeat(Math.round(this.beatAt(pos)));
    updateTrack(t.id, { anchor: Math.abs(near - pos) < 0.05 ? near : pos, analysisVersion: -1 });
  }

  /** Changes the BPM, keeping the beat under the playhead where it is. */
  gridBpm(delta: number) {
    const t = this.track();
    if (!t?.bpm) return;
    const pos = this.live.pos;
    const k = Math.round(this.beatAt(pos));
    const pinned = this.timeOfBeat(k);
    const bpm = Math.round((t.bpm + delta) * 1000) / 1000;
    updateTrack(t.id, { bpm, anchor: pinned - (k * 60) / bpm, analysisVersion: -1 });
  }

  gridHalve(factor: number) {
    const t = this.track();
    if (!t?.bpm) return;
    updateTrack(t.id, { bpm: t.bpm * factor, analysisVersion: -1 });
  }
}

// --- All decks, and which one is the master ---------------------------------------

export type PadMode = "hotcue" | "loop" | "jump";

export const decks: Deck[] = [0, 1, 2, 3].map((i) => new Deck(i));

function setMasterDeck(d: Deck | null) {
  for (const x of decks) if (x !== d && x.master()) x.setMaster(false);
  if (d && !d.master()) d.setMaster(true);
}

/** The master moves to a playing deck when the current one stops or empties. */
export function updateMaster() {
  const cur = decks.find((d) => d.master());
  const playing = decks.filter((d) => d.live.playing && d.hasGrid());
  if (cur && cur.hasGrid() && (cur.live.playing || playing.length === 0)) return;
  const next = playing.find((d) => !d.sync()) ?? playing[0] ?? decks.find((d) => d.hasGrid()) ?? null;
  if (next !== (cur ?? null)) setMasterDeck(next);
}

function onSyncEngaged(d: Deck) {
  // A deck syncs to another: if it is the master, hand that to a playing deck.
  if (d.master()) {
    const other = decks.find((x) => x !== d && x.live.playing && x.hasGrid());
    if (other) setMasterDeck(other);
  }
  updateMaster();
}

function onDeckLoaded(_d: Deck) {
  updateMaster();
}

export function makeMaster(d: Deck) {
  setMasterDeck(d);
}

export function masterDeck(): Deck | undefined {
  return decks.find((d) => d.master());
}
