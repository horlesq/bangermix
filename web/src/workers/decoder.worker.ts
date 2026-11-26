/// <reference lib="webworker" />
// Decodes, analyses and reads tags with worker.wasm (crates/bm-worker-wasm).

import type { AnalysisResult, JobRequest, JobResult, TagsResult } from "./protocol";

interface Exports {
  memory: WebAssembly.Memory;
  wk_input(len: number): number;
  wk_ext(): number;
  wk_decode(extLen: number, mono: number): number;
  wk_probe(extLen: number): number;
  wk_analyse(minBpm: number, maxBpm: number, columnsPerS: number): number;
  wk_pcm(channel: number): number;
  wk_pcm_frames(): number;
  wk_free_pcm(): void;
  wk_json(): number;
  wk_json_len(): number;
  wk_bytes(): number;
  wk_bytes_len(): number;
  wk_export_pioneer_db(): number;
  wk_export_pioneer_track(columnsPerS: number): number;
  wk_read_pioneer_db(): number;
  wk_read_pioneer_analysis(): number;
}

const ready: Promise<Exports> = WebAssembly.instantiateStreaming(fetch("/wasm/worker.wasm"), {}).then(
  (r) => r.instance.exports as unknown as Exports,
);

const utf8 = new TextDecoder();
const utf8enc = new TextEncoder();

function write(w: Exports, bytes: Uint8Array, ext: string): number {
  const ptr = w.wk_input(bytes.length);
  new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
  const e = utf8enc.encode(ext.toLowerCase().slice(0, 15));
  new Uint8Array(w.memory.buffer, w.wk_ext(), e.length).set(e);
  return e.length;
}

function json(w: Exports): any {
  const text = utf8.decode(new Uint8Array(w.memory.buffer, w.wk_json(), w.wk_json_len()).slice());
  return JSON.parse(text);
}

function bytes(w: Exports): Uint8Array {
  return new Uint8Array(w.memory.buffer, w.wk_bytes(), w.wk_bytes_len()).slice();
}

/** Reads a bundle of files (bm_export::bundle): u32 path length, path, u32 length, bytes. */
function unbundle(b: Uint8Array): { path: string; data: Uint8Array }[] {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const files: { path: string; data: Uint8Array }[] = [];
  for (let o = 0; o < b.length; ) {
    const n = view.getUint32(o, true);
    const path = utf8.decode(b.subarray(o + 4, o + 4 + n));
    o += 4 + n;
    const len = view.getUint32(o, true);
    files.push({ path, data: b.slice(o + 4, o + 4 + len) });
    o += 4 + len;
  }
  return files;
}

function run(w: Exports, req: JobRequest): { result: JobResult; transfer: Transferable[] } {
  const data = new Uint8Array(req.bytes);
  if (req.op === "pioneerTrack" || req.op === "pioneerDb") {
    write(w, data, "");
    const ok = (req.op === "pioneerDb" ? w.wk_export_pioneer_db() : w.wk_export_pioneer_track(req.columnsPerS)) === 0;
    if (!ok) throw new Error(json(w).error);
    const files = unbundle(new Uint8Array(w.memory.buffer, w.wk_bytes(), w.wk_bytes_len()));
    return { result: { files }, transfer: files.map((f) => f.data.buffer) };
  }
  if (req.op === "pioneerRead" || req.op === "pioneerReadAnalysis") {
    write(w, data, "");
    const ok = (req.op === "pioneerRead" ? w.wk_read_pioneer_db() : w.wk_read_pioneer_analysis()) === 0;
    const j = json(w);
    if (!ok) throw new Error(j.error);
    return { result: { json: j }, transfer: [] };
  }
  const extLen = write(w, data, req.ext);
  if (req.op === "probe") {
    const ok = w.wk_probe(extLen) === 0;
    const j = json(w);
    if (!ok) throw new Error(j.error);
    const art = j.artType ? bytes(w) : null;
    const tags: TagsResult = { ...j, art };
    return { result: { tags }, transfer: art ? [art.buffer] : [] };
  }
  const mono = req.op === "analyse";
  if (w.wk_decode(extLen, mono ? 1 : 0) !== 0) throw new Error(json(w).error);
  const info = json(w);
  const transfer: Transferable[] = [];
  const result: JobResult = { rate: info.rate };
  if (req.analyse) {
    const [min, max] = req.bpmRange;
    if (w.wk_analyse(min, max, req.columnsPerS) !== 0) throw new Error(json(w).error);
    const analysis: AnalysisResult = json(w);
    const waveform = bytes(w);
    result.analysis = analysis;
    result.waveform = waveform;
    transfer.push(waveform.buffer);
  }
  if (req.op === "decode") {
    const frames = w.wk_pcm_frames();
    const left = new Float32Array(w.memory.buffer, w.wk_pcm(0), frames).slice();
    const right = new Float32Array(w.memory.buffer, w.wk_pcm(1), frames).slice();
    result.left = left;
    result.right = right;
    transfer.push(left.buffer, right.buffer);
  }
  w.wk_free_pcm();
  return { result, transfer };
}

self.onmessage = async (e: MessageEvent<JobRequest & { id: number }>) => {
  const { id } = e.data;
  try {
    const w = await ready;
    const { result, transfer } = run(w, e.data);
    (self as DedicatedWorkerGlobalScope).postMessage({ id, result }, transfer);
  } catch (err) {
    (self as DedicatedWorkerGlobalScope).postMessage({ id, error: String((err as Error).message ?? err) });
  }
};
