// Exports playlists to a USB stick for standalone players: copies the music into
// `Contents/`, then writes a rekordbox device library (Pioneer CDJ/XDJ) and/or an Engine
// DJ library (Denon). Both point at the same copied files, so one stick serves both.

import { camelot, camelotText, keyName } from "../lib/keys";
import type { TrackRec } from "../lib/types";
import { pool } from "../state/app";
import { fileFor, needsAnalysis, storeAnalysis, trackById, WAVEFORM_COLUMNS_PER_S, waveformFor } from "../state/library";
import { settings } from "../state/settings";
import { ENGINE_DB_PATH, type ExportLibrary, type ExportPlaylist, type ExportTrack } from "./model";

/** What players play. Ogg and Opus are not among them. */
const PLAYABLE = new Set(["mp3", "m4a", "aac", "mp4", "wav", "wave", "aif", "aiff", "flac"]);
const LOSSLESS = new Set(["wav", "wave", "aif", "aiff", "flac"]);

export interface UsbPlaylist {
  /** Shown as "Folder / Name" in bangermix; folders become folders on the stick. Empty:
   * the tracks go on the stick without a playlist (the whole collection). */
  name: string;
  trackIds: string[];
}

export interface UsbOptions {
  pioneer: boolean;
  engine: boolean;
}

export interface UsbProgress {
  phase: string;
  done: number;
  total: number;
  current?: string;
}

export interface UsbReport {
  tracks: number;
  copied: number;
  analysed: number;
  skipped: { title: string; reason: string }[];
  seconds: number;
}

/** A name that FAT32 and exFAT accept, at most `max` characters. */
export function safeName(name: string, max = 100): string {
  let s = name
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  if (!s) s = "_";
  if (s.length > max) {
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 6 ? s.slice(dot) : "";
    s = s.slice(0, max - ext.length).trimEnd() + ext;
  }
  return s;
}

/** Where a track goes on the stick: `/Contents/Artist/Album/file`. */
export function devicePath(t: TrackRec): string {
  return `/Contents/${safeName(t.artist || "Unknown Artist")}/${safeName(t.album || "Unknown Album")}/${safeName(t.name, 120)}`;
}

/** Engine DJ's key number: round the circle of fifths from C major (0), A minor (1). */
export function engineKey(k: TrackRec["key"]): number | undefined {
  if (!k) return undefined;
  const c = camelot(k);
  return 2 * ((((c.number - 8) % 12) + 12) % 12) + (c.letter === "A" ? 1 : 0);
}

class Writer {
  private dirs = new Map<string, Promise<FileSystemDirectoryHandle>>();
  constructor(private root: FileSystemDirectoryHandle) {}

  private dir(path: string[]): Promise<FileSystemDirectoryHandle> {
    if (path.length === 0) return Promise.resolve(this.root);
    const key = path.join("/");
    let d = this.dirs.get(key);
    if (!d) {
      d = this.dir(path.slice(0, -1)).then((parent) => parent.getDirectoryHandle(path[path.length - 1], { create: true }));
      this.dirs.set(key, d);
    }
    return d;
  }

  private split(path: string): { dir: string[]; name: string } {
    const parts = path.split("/").filter(Boolean);
    return { dir: parts.slice(0, -1), name: parts[parts.length - 1] };
  }

  /** The size of a file already on the stick, or -1. */
  async size(path: string): Promise<number> {
    const { dir, name } = this.split(path);
    try {
      let d = this.root;
      for (const p of dir) d = await d.getDirectoryHandle(p);
      return (await (await d.getFileHandle(name)).getFile()).size;
    } catch {
      return -1;
    }
  }

  async write(path: string, data: BufferSource | Blob) {
    const { dir, name } = this.split(path);
    const d = await this.dir(dir);
    const fh = await d.getFileHandle(name, { create: true });
    const w = await (fh as any).createWritable();
    await w.write(data);
    await w.close();
  }
}

/** `[u32 JSON length][JSON][data]`, the input of the worker's export calls. */
function payload(value: unknown, data?: Uint8Array): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(value));
  const out = new Uint8Array(4 + json.length + (data?.length ?? 0));
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  if (data) out.set(data, 4 + json.length);
  return out.buffer;
}

function day(ms: number): string {
  const d = new Date(ms || Date.now());
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function exportToUsb(
  root: FileSystemDirectoryHandle,
  playlists: UsbPlaylist[],
  options: UsbOptions,
  onProgress: (p: UsbProgress) => void,
  signal?: AbortSignal,
): Promise<UsbReport> {
  const started = performance.now();
  const out = new Writer(root);
  const report: UsbReport = { tracks: 0, copied: 0, analysed: 0, skipped: [], seconds: 0 };

  // The tracks, each once, in playlist order.
  const ids: string[] = [];
  for (const p of playlists) for (const id of p.trackIds) if (!ids.includes(id)) ids.push(id);
  const used = new Set<string>();
  const tracks: ExportTrack[] = [];
  const index = new Map<string, number>();

  for (let n = 0; n < ids.length; n++) {
    if (signal?.aborted) throw new Error("Export cancelled.");
    const t = trackById(ids[n]);
    if (!t) continue;
    onProgress({ phase: "Copying music", done: n, total: ids.length, current: t.title || t.name });
    if (!PLAYABLE.has(t.ext.toLowerCase())) {
      report.skipped.push({ title: t.title || t.name, reason: `${t.ext.toUpperCase()} files don't play on CDJs or Denon players` });
      continue;
    }
    let file: File;
    try {
      file = await fileFor(t);
    } catch (e) {
      report.skipped.push({ title: t.title || t.name, reason: (e as Error).message });
      continue;
    }

    // Two different tracks may want the same path: number the later one.
    let path = devicePath(t);
    for (let k = 2; used.has(path.toLowerCase()); k++) {
      const dot = t.name.lastIndexOf(".");
      const base = dot > 0 ? t.name.slice(0, dot) : t.name;
      path = `${devicePath(t).slice(0, devicePath(t).lastIndexOf("/") + 1)}${safeName(`${base} (${k})${dot > 0 ? t.name.slice(dot) : ""}`, 120)}`;
    }
    used.add(path.toLowerCase());

    const bytes = await file.arrayBuffer();
    if ((await out.size(path)) !== file.size) {
      await out.write(path, bytes);
      report.copied++;
    }

    // Sample rate and bit depth from the file; the grid and waveform from analysis
    // (analysing now if it was never done).
    let fresh = t;
    let sampleRate = 44100;
    let bitDepth = LOSSLESS.has(t.ext.toLowerCase()) ? 16 : 0;
    try {
      if (needsAnalysis(t)) {
        onProgress({ phase: "Analysing", done: n, total: ids.length, current: t.title || t.name });
        const r = await pool.run({
          op: "analyse",
          analyse: true,
          bytes: bytes.slice(0),
          ext: t.ext,
          bpmRange: [settings.bpmMin, settings.bpmMax],
          columnsPerS: WAVEFORM_COLUMNS_PER_S,
        });
        if (r.analysis && r.waveform) {
          await storeAnalysis(t.id, r.analysis, r.waveform);
          report.analysed++;
        }
        if (r.rate) sampleRate = r.rate;
        fresh = trackById(t.id) ?? t;
      }
      const probe = await pool.run({ op: "probe", bytes, ext: t.ext, bpmRange: [0, 0], columnsPerS: 0 });
      if (probe.tags?.sampleRate) sampleRate = probe.tags.sampleRate;
      if (probe.tags?.bitDepth) bitDepth = probe.tags.bitDepth;
    } catch {
      /* keep the defaults: the file still plays */
    }

    const duration = fresh.duration ?? 0;
    const lossless = LOSSLESS.has(t.ext.toLowerCase());
    const bitrate = lossless
      ? Math.round((sampleRate * (bitDepth || 16) * 2) / 1000)
      : duration > 0
        ? Math.round((file.size * 8) / duration / 1000)
        : 0;
    const et: ExportTrack = {
      filePath: path,
      title: fresh.title || fresh.name,
      artist: fresh.artist,
      album: fresh.album,
      genre: fresh.genre,
      comment: fresh.comment,
      label: "",
      key: fresh.key ? (settings.keyNotation === "camelot" ? camelotText(fresh.key) : keyName(fresh.key)) : "",
      engineKey: engineKey(fresh.key),
      bpm: fresh.bpm ?? 0,
      anchor: fresh.anchor ?? 0,
      duration,
      sampleRate,
      bitDepth,
      bitrate,
      fileSize: file.size,
      fileType: t.ext.toLowerCase() === "wave" ? "wav" : t.ext.toLowerCase(),
      year: parseInt(fresh.year, 10) || 0,
      rating: fresh.rating,
      playCount: fresh.playCount,
      dateAdded: day(fresh.dateAdded),
      added: Math.floor((fresh.dateAdded || Date.now()) / 1000),
      cue: fresh.cue,
      hotCues: fresh.hotCues.flatMap((c, i) =>
        c ? [{ index: i, time: c.time, loopEnd: c.loopEnd, color: c.color, name: c.name ?? "" }] : [],
      ),
      memoryCues: fresh.memoryCues.map((c) => ({ time: c.time, loopEnd: c.loopEnd, name: c.name ?? "" })),
    };

    if (options.pioneer) {
      const waveform = (await waveformFor(t.id)) ?? new Uint8Array();
      const r = await pool.run({
        op: "pioneerTrack",
        bytes: payload(et, waveform),
        ext: "",
        bpmRange: [0, 0],
        columnsPerS: WAVEFORM_COLUMNS_PER_S,
      });
      for (const f of r.files ?? []) await out.write(f.path, f.data as BufferSource);
    }
    index.set(t.id, tracks.length);
    tracks.push(et);
  }
  report.tracks = tracks.length;

  const lists: ExportPlaylist[] = playlists.filter((p) => p.name).map((p) => {
    const parts = p.name.split(" / ").map((s) => s.trim()).filter(Boolean);
    return {
      folders: parts.slice(0, -1),
      name: parts[parts.length - 1] ?? p.name,
      tracks: p.trackIds.map((id) => index.get(id)).filter((i): i is number => i !== undefined),
    };
  });
  const library: ExportLibrary = { tracks, playlists: lists };

  if (options.pioneer) {
    onProgress({ phase: "Writing the rekordbox library", done: 0, total: 1 });
    const r = await pool.run({ op: "pioneerDb", bytes: payload(library), ext: "", bpmRange: [0, 0], columnsPerS: 0 });
    // export.pdb comes last, so an interrupted export leaves the old one whole.
    for (const f of r.files ?? []) await out.write(f.path, f.data as BufferSource);
  }
  if (options.engine) {
    const { engineDatabase } = await import("./engine");
    const ordered = [...index.keys()];
    const db = await engineDatabase({
      library,
      columnsPerS: WAVEFORM_COLUMNS_PER_S,
      waveform: (i) => waveformFor(ordered[i]),
      progress: (done, total) => onProgress({ phase: "Writing the Engine DJ library", done, total }),
    });
    await out.write(ENGINE_DB_PATH, db as BufferSource);
  }
  report.seconds = (performance.now() - started) / 1000;
  return report;
}
