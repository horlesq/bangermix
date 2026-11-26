// Reads an Engine DJ library (`Engine Library/Database2/m.db`, on the computer or on a
// stick): tracks, their beat grids, hot cues, main cue and saved loops, and playlists.
// Engine DJ 2 and 3 keep the performance data in the Track table, Engine DJ 4 and later in
// PerformanceData; both are read. Blob layouts as in libdjinterop, mirrored by
// ../export/engine.ts.

import type { Database, SqlJsStatic } from "sql.js";
import { parseKey } from "../lib/keys";
import type { Cue } from "../lib/types";
import { baseName, hexColor, type ImportedLibrary, type ImportedPlaylist, type ImportedTrack, noHotCues } from "./model";

/** qUncompress: a big-endian u32 length, then zlib data. */
export async function qUncompress(blob: Uint8Array | null | undefined): Promise<Uint8Array | undefined> {
  if (!blob || blob.length < 5) return undefined;
  try {
    const stream = new Blob([blob.subarray(4) as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return undefined;
  }
}

/** Engine's key number (C major 0, A minor 1, G major 2 … round the circle of fifths). */
export function fromEngineKey(k: number | null | undefined) {
  if (k === null || k === undefined || k < 0 || k > 23) return undefined;
  const camelot = (((k >> 1) + 7) % 12) + 1;
  return parseKey(`${camelot}${k & 1 ? "A" : "B"}`);
}

class Reader {
  o = 0;
  private v: DataView;
  constructor(private b: Uint8Array) {
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  get left() {
    return this.b.length - this.o;
  }
  u8() {
    return this.b[this.o++];
  }
  f64(le = false) {
    const x = this.v.getFloat64(this.o, le);
    this.o += 8;
    return x;
  }
  i64(le = false) {
    const x = Number(this.v.getBigInt64(this.o, le));
    this.o += 8;
    return x;
  }
  i32(le = false) {
    const x = this.v.getInt32(this.o, le);
    this.o += 4;
    return x;
  }
  text(n: number) {
    const s = new TextDecoder().decode(this.b.subarray(this.o, this.o + n));
    this.o += n;
    return s;
  }
}

/** The (adjusted) beat grid: BPM and the time of a downbeat (beat index 0 mod 4). */
export function readBeatData(d: Uint8Array): { sampleRate: number; bpm: number; anchor: number } | undefined {
  if (d.length < 17 + 8) return undefined;
  const r = new Reader(d);
  const sampleRate = r.f64();
  r.f64();
  r.u8();
  const grid = () => {
    const n = r.i64();
    if (n < 0 || n * 24 > r.left) return [];
    return Array.from({ length: n }, () => {
      const m = { offset: r.f64(true), index: r.i64(true) };
      r.i32(true);
      r.i32(true);
      return m;
    });
  };
  const analysed = grid();
  const adjusted = r.left >= 8 ? grid() : [];
  const m = adjusted.length >= 2 ? adjusted : analysed;
  if (m.length < 2 || !(sampleRate > 0)) return undefined;
  const a = m[0];
  const b = m[m.length - 1];
  const samplesPerBeat = (b.offset - a.offset) / (b.index - a.index);
  if (!(samplesPerBeat > 0)) return undefined;
  const bpm = (60 * sampleRate) / samplesPerBeat;
  // The beat numbered 0 is a downbeat; step to the first one in the track.
  const beat0 = a.offset / sampleRate - (a.index * samplesPerBeat) / sampleRate;
  const beat = 60 / bpm;
  const anchor = beat0 + Math.ceil(-beat0 / (4 * beat) - 1e-9) * 4 * beat;
  return { sampleRate, bpm, anchor };
}

export function readQuickCues(d: Uint8Array, sampleRate: number): { hotCues: (Cue | null)[]; cue?: number } {
  const hotCues = noHotCues();
  const r = new Reader(d);
  if (r.left < 8) return { hotCues };
  const n = r.i64();
  for (let i = 0; i < n && r.left > 13; i++) {
    const name = r.text(r.u8());
    const offset = r.f64();
    r.u8();
    const [red, green, blue] = [r.u8(), r.u8(), r.u8()];
    if (offset >= 0 && i < 8) {
      const cue: Cue = { time: offset / sampleRate, color: hexColor(red, green, blue) };
      if (name) cue.name = name;
      hotCues[i] = cue;
    }
  }
  let cue: number | undefined;
  if (r.left >= 8) {
    const main = r.f64();
    if (main > 0) cue = main / sampleRate;
  }
  return { hotCues, cue };
}

export function readLoops(d: Uint8Array, sampleRate: number): Cue[] {
  const r = new Reader(d);
  if (r.left < 8) return [];
  const n = r.i64(true);
  const loops: Cue[] = [];
  for (let i = 0; i < n && r.left > 22; i++) {
    const name = r.text(r.u8());
    const start = r.f64(true);
    const end = r.f64(true);
    const set = r.u8() && r.u8();
    r.u8();
    const [red, green, blue] = [r.u8(), r.u8(), r.u8()];
    if (set && start >= 0 && end > start) {
      const loop: Cue = { time: start / sampleRate, loopEnd: end / sampleRate, color: hexColor(red, green, blue) };
      if (name) loop.name = name;
      loops.push(loop);
    }
  }
  return loops;
}

type Row = Record<string, unknown>;

function rows(db: Database, sql: string): Row[] {
  const res = db.exec(sql)[0];
  if (!res) return [];
  return res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]])));
}

function columns(db: Database, table: string): Set<string> {
  return new Set(rows(db, `PRAGMA table_info(${table})`).map((r) => String(r.name)));
}

const blob = (x: unknown) => (x instanceof Uint8Array ? x : undefined);
const str = (x: unknown) => (typeof x === "string" ? x : x === null || x === undefined ? "" : String(x));
const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);

/** Follows a linked list (`next` 0 at the end) from the item nobody points to. */
function chain<T>(items: T[], id: (t: T) => number, next: (t: T) => number): T[] {
  const byId = new Map(items.map((t) => [id(t), t]));
  const pointedTo = new Set(items.map(next));
  const out: T[] = [];
  const seen = new Set<number>();
  for (const head of items.filter((t) => !pointedTo.has(id(t)))) {
    for (let t: T | undefined = head; t && !seen.has(id(t)); t = byId.get(next(t))) {
      seen.add(id(t));
      out.push(t);
    }
  }
  // Anything left (a broken list) keeps its stored order.
  for (const t of items) if (!seen.has(id(t))) out.push(t);
  return out;
}

export async function readEngineDatabase(bytes: Uint8Array, SQL: SqlJsStatic): Promise<ImportedLibrary> {
  let db: Database;
  try {
    db = new SQL.Database(bytes);
    db.exec("SELECT 1 FROM Track LIMIT 1");
  } catch {
    throw new Error("This is not an Engine DJ library (Database2/m.db).");
  }
  try {
    const perfTable = columns(db, "PerformanceData").has("beatData");
    const perfCols = perfTable ? "p.trackData, p.beatData, p.quickCues, p.loops" : "t.trackData, t.beatData, t.quickCues, t.loops";
    const join = perfTable ? "LEFT JOIN PerformanceData p ON p.trackId = t.id" : "";
    const list = rows(
      db,
      `SELECT t.id, t.path, t.filename, t.fileBytes, t.title, t.artist, t.album, t.genre, t.comment,
              t.rating, t.bpm, t.bpmAnalyzed, t.key, ${perfCols}
       FROM Track t ${join} ORDER BY t.id`,
    );
    const tracks: ImportedTrack[] = [];
    for (const r of list) {
      const path = str(r.path);
      if (!path) continue;
      const t: ImportedTrack = {
        id: String(r.id),
        fileName: str(r.filename) || baseName(path),
        location: path,
        size: n(r.fileBytes),
        title: str(r.title),
        artist: str(r.artist),
        album: str(r.album),
        genre: str(r.genre),
        comment: str(r.comment),
        rating: Math.round((n(r.rating) ?? 0) / 20),
        key: fromEngineKey(n(r.key)),
      };
      const bpm = n(r.bpmAnalyzed) || n(r.bpm);
      if (bpm && bpm > 0) t.bpm = bpm;

      const trackData = await qUncompress(blob(r.trackData));
      let sampleRate = trackData && trackData.length >= 8 ? new DataView(trackData.buffer).getFloat64(0, false) : 0;
      const beats = await qUncompress(blob(r.beatData));
      const grid = beats && readBeatData(beats);
      if (grid) {
        t.bpm = grid.bpm;
        t.anchor = grid.anchor;
        sampleRate ||= grid.sampleRate;
      }
      if (sampleRate > 0) {
        const cues = await qUncompress(blob(r.quickCues));
        if (cues) {
          const q = readQuickCues(cues, sampleRate);
          if (q.hotCues.some(Boolean)) t.hotCues = q.hotCues;
          t.cue = q.cue;
        }
        const loops = blob(r.loops);
        if (loops) {
          // A loop that starts on a hot cue is that hot cue's loop (as bangermix and
          // rekordbox keep them); the rest are saved loops of their own.
          const own: Cue[] = [];
          for (const l of readLoops(loops, sampleRate)) {
            const hot = t.hotCues?.find((c) => c && Math.abs(c.time - l.time) < 0.002 && c.loopEnd === undefined);
            if (hot) hot.loopEnd = l.loopEnd;
            else own.push(l);
          }
          if (own.length) t.memoryCues = own;
        }
      }
      tracks.push(t);
    }

    // Playlists: a tree by parentListId, siblings and entries as linked lists.
    const lists = rows(db, "SELECT id, title, parentListId, nextListId FROM Playlist").map((r) => ({
      id: Number(r.id),
      title: str(r.title),
      parent: Number(r.parentListId) || 0,
      next: Number(r.nextListId) || 0,
    }));
    const entities = rows(db, "SELECT id, listId, trackId, nextEntityId FROM PlaylistEntity").map((r) => ({
      id: Number(r.id),
      list: Number(r.listId),
      track: String(r.trackId),
      next: Number(r.nextEntityId) || 0,
    }));
    const playlists: ImportedPlaylist[] = [];
    const visit = (parent: number, path: string[], depth: number) => {
      if (depth > 32) return;
      const siblings = chain(
        lists.filter((l) => l.parent === parent),
        (l) => l.id,
        (l) => l.next,
      );
      for (const l of siblings) {
        const name = [...path, l.title];
        const entries = chain(
          entities.filter((e) => e.list === l.id),
          (e) => e.id,
          (e) => e.next,
        );
        if (entries.length) playlists.push({ name: name.join(" / "), trackIds: entries.map((e) => e.track) });
        visit(l.id, name, depth + 1);
      }
    };
    visit(0, [], 0);
    return { source: "Engine DJ", tracks, playlists };
  } finally {
    db.close();
  }
}
