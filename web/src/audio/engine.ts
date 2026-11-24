// The main thread's handle on the audio engine running in the AudioWorklet.

import { DECK_STATE, GLOBAL, GLOBAL_STATE, STATE_LEN } from "./params";

/** stereo: master only; quad: headphones on outputs 3-4; split: mono master left,
 * mono headphones right; device: headphones on a second output device. */
export type OutputMode = "stereo" | "quad" | "split" | "device";

export interface AudioOptions {
  sinkId?: string;
  mode: OutputMode;
  phonesSinkId?: string;
}

/** Ring size and layout shared with worklet.js (PhonesRing). */
const PHONES_RING_FRAMES = 16384;

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly node: AudioWorkletNode;
  /** The latest engine state: shared memory when cross-origin isolated, else copies. */
  state: Float64Array;
  private pending: [number, number, number][] = [];
  private flushQueued = false;
  private loadWaiters = new Map<number, () => void>();
  private nextToken = 1;
  private phones: { ctx: AudioContext; node: AudioWorkletNode } | null = null;
  /** Called on every state message when there is no shared memory. */
  readonly shared: boolean;

  private constructor(ctx: AudioContext, node: AudioWorkletNode, state: Float64Array, shared: boolean) {
    this.ctx = ctx;
    this.node = node;
    this.state = state;
    this.shared = shared;
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "state") this.state = m.state;
      else if (m.type === "loaded") {
        this.loadWaiters.get(m.token)?.();
        this.loadWaiters.delete(m.token);
      }
    };
  }

  static async start(opts: AudioOptions): Promise<AudioEngine> {
    const ctx = new AudioContext({ latencyHint: "interactive" });
    if (opts.sinkId) await setSink(ctx, opts.sinkId);
    const [module] = await Promise.all([
      WebAssembly.compileStreaming(fetch("/wasm/engine.wasm")),
      ctx.audioWorklet.addModule("/worklet.js"),
    ]);
    const shared = typeof SharedArrayBuffer !== "undefined" && crossOriginIsolated;
    const sab = shared ? new SharedArrayBuffer(STATE_LEN * 8) : null;
    const node = new AudioWorkletNode(ctx, "bangermix", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [4],
      processorOptions: { module, sab, mode: opts.mode },
    });
    // Discrete: outputs 3 and 4 (headphones) are never mixed into a stereo device.
    node.channelInterpretation = "discrete";
    const dest = ctx.destination;
    dest.channelInterpretation = "discrete";
    dest.channelCountMode = "explicit";
    dest.channelCount = opts.mode === "quad" ? Math.min(4, dest.maxChannelCount) : 2;
    node.connect(dest);
    const state = sab ? new Float64Array(sab) : new Float64Array(STATE_LEN);
    const engine = new AudioEngine(ctx, node, state, shared);
    if (opts.mode === "device" && opts.phonesSinkId) await engine.startPhones(opts.phonesSinkId);
    return engine;
  }

  /** How many output channels the device offers (4 or more allows headphone cue). */
  get maxChannels(): number {
    return this.ctx.destination.maxChannelCount;
  }

  setMode(mode: OutputMode, phonesSinkId?: string) {
    const dest = this.ctx.destination;
    dest.channelCount = mode === "quad" ? Math.min(4, dest.maxChannelCount) : 2;
    this.node.port.postMessage({ type: "mode", mode: mode === "device" ? "stereo" : mode });
    if (mode === "device" && phonesSinkId) void this.startPhones(phonesSinkId);
    else void this.stopPhones();
  }

  /** Plays the headphone mix on a second output device. Needs shared memory. */
  async startPhones(sinkId: string): Promise<boolean> {
    await this.stopPhones();
    if (!this.shared) return false;
    const ctx = new AudioContext({ latencyHint: "interactive", sampleRate: this.ctx.sampleRate });
    await setSink(ctx, sinkId);
    await ctx.audioWorklet.addModule("/worklet.js");
    const sab = new SharedArrayBuffer(8 + PHONES_RING_FRAMES * 2 * 4);
    const node = new AudioWorkletNode(ctx, "bangermix-phones", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { sab },
    });
    node.connect(ctx.destination);
    this.node.port.postMessage({ type: "phones", sab });
    this.phones = { ctx, node };
    if (ctx.state !== "running") void ctx.resume();
    return true;
  }

  async stopPhones() {
    if (!this.phones) return;
    this.node.port.postMessage({ type: "phones", sab: null });
    const p = this.phones;
    this.phones = null;
    p.node.disconnect();
    await p.ctx.close();
  }

  /** Resumes both contexts (browsers start them suspended until the page is used). */
  resume() {
    if (this.ctx.state !== "running") void this.ctx.resume();
    if (this.phones && this.phones.ctx.state !== "running") void this.phones.ctx.resume();
  }

  async setSink(sinkId: string) {
    await setSink(this.ctx, sinkId);
  }

  /** Sets an engine parameter. Changes in one task go to the audio thread together. */
  set(deck: number, param: number, value: number) {
    this.pending.push([deck, param, value]);
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => {
        this.flushQueued = false;
        this.node.port.postMessage({ type: "set", params: this.pending });
        this.pending = [];
      });
    }
  }

  setGlobal(param: number, value: number) {
    this.set(GLOBAL, param, value);
  }

  /** Hands decoded audio to a deck; resolves once the audio thread has all of it. */
  load(deck: number, left: Float32Array, right: Float32Array, rate: number): Promise<void> {
    const token = this.nextToken++;
    return new Promise((resolve) => {
      this.loadWaiters.set(token, resolve);
      this.node.port.postMessage({ type: "load", deck, left, right, rate, token }, [
        left.buffer,
        right.buffer,
      ]);
    });
  }

  unload(deck: number) {
    this.node.port.postMessage({ type: "unload", deck });
  }

  deck(deck: number, value: number): number {
    return this.state[deck * DECK_STATE + value];
  }

  global(value: number): number {
    return this.state[GLOBAL_STATE + value];
  }

  /** Seconds between the engine rendering a sample and it being heard. */
  get latency(): number {
    return (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
  }
}

async function setSink(ctx: AudioContext, sinkId: string) {
  const c = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (c.setSinkId) {
    try {
      await c.setSinkId(sinkId === "default" ? "" : sinkId);
    } catch (e) {
      console.warn("could not switch the output device", e);
    }
  }
}

export async function outputDevices(): Promise<MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "audiooutput");
}
