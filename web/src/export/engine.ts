// An Engine DJ library for Denon DJ players (Prime, SC series, Engine OS):
// `Engine Library/Database2/m.db`, an SQLite database. Schema 3.0.0, which Engine DJ
// 4.1 and later read (newer versions upgrade it in place).
//
// The format follows libdjinterop (github.com/xsco/libdjinterop), the open library
// that Mixxx uses for its Engine exports, tested on real players: the schema itself
// (engine-schema-3.0.0.sql, from libdjinterop), the row values it writes for a new
// track, and the encoding of each performance-data blob (src/djinterop/engine/v2/*_blob.cpp).

import type { Database } from "sql.js";
import { sqlite } from "../lib/sqlite";
import { type Bands, Columns, evenly } from "./bands";
import type { ExportLibrary, ExportTrack } from "./model";
export { ENGINE_DB_PATH } from "./model";
import schemaSql from "./engine-schema-3.0.0.sql?raw";

const SCHEMA = { major: 3, minor: 0, patch: 0 };


// --- Blobs ----------------------------------------------------------------------------

class Bytes {
  private buf: ArrayBuffer;
  private view: DataView;
  private pos = 0;
  constructor(size: number) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
  }
  u8(v: number) {
    this.view.setUint8(this.pos, v & 0xff);
    this.pos += 1;
    return this;
  }
  i32(v: number, little = false) {
    this.view.setInt32(this.pos, v, little);
    this.pos += 4;
    return this;
  }
  i64(v: number, little = false) {
    this.view.setBigInt64(this.pos, BigInt(Math.trunc(v)), little);
    this.pos += 8;
    return this;
  }
  f64(v: number, little = false) {
    this.view.setFloat64(this.pos, v, little);
    this.pos += 8;
    return this;
  }
  raw(b: Uint8Array) {
    new Uint8Array(this.buf, this.pos, b.length).set(b);
    this.pos += b.length;
    return this;
  }
  done(): Uint8Array {
    if (this.pos !== this.buf.byteLength) throw new Error(`blob size ${this.pos} != ${this.buf.byteLength}`);
    return new Uint8Array(this.buf);
  }
}

/** zlib with a 4-byte big-endian length in front (Qt's qCompress), as Engine stores blobs. */
export async function qCompress(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate"));
  const z = new Uint8Array(await new Response(stream).arrayBuffer());
  const out = new Uint8Array(4 + z.length);
  new DataView(out.buffer).setUint32(0, data.length, false);
  out.set(z, 4);
  return out;
}

/** Sample offset of a time, at the file's rate. */
const at = (t: ExportTrack, seconds: number) => seconds * t.sampleRate;
const frames = (t: ExportTrack) => Math.round(t.duration * t.sampleRate);

/** trackData: sample rate, sample count, key, and three loudness values (0 = players
 * don't rescale the waveform). */
export function trackData(t: ExportTrack): Uint8Array {
  return new Bytes(44)
    .f64(t.sampleRate)
    .i64(frames(t))
    .i32(t.engineKey ?? 0)
    .f64(0)
    .f64(0)
    .f64(0)
    .done();
}

/** The beat grid as two markers, a few beats before the start and after the end, with
 * marker index 0 on the first downbeat (bar positions come from the index). */
export function beatMarkers(t: ExportTrack): { offset: number; index: number }[] {
  if (!(t.bpm > 0) || !(t.duration > 0)) return [];
  const beat = 60 / t.bpm;
  // k counts beats from the anchor (a downbeat); the first downbeat at or after 0 s is index 0.
  const firstDownbeat = 4 * Math.ceil(-t.anchor / beat / 4 - 1e-9);
  const lastBeat = Math.ceil((t.duration - t.anchor) / beat) - firstDownbeat;
  const marker = (index: number) => ({ offset: at(t, t.anchor + (index + firstDownbeat) * beat), index });
  return [marker(-4), marker(lastBeat + 4)];
}

export function beatData(t: ExportTrack): Uint8Array {
  const markers = beatMarkers(t);
  const b = new Bytes(33 + 24 * 2 * markers.length + 9)
    .f64(t.sampleRate)
    .f64(frames(t))
    .u8(markers.length ? 1 : 0);
  for (let grid = 0; grid < 2; grid++) {
    // The default (analysed) grid and the adjusted one: the same here.
    b.i64(markers.length);
    markers.forEach((m, i) => {
      const next = markers[i + 1];
      b.f64(m.offset, true)
        .i64(m.index, true)
        .i32(next ? next.index - m.index : 0, true)
        .i32(0, true);
    });
  }
  // "Real beat data seems to have 9 additional zero bytes at the end" (libdjinterop).
  return b.raw(new Uint8Array(9)).done();
}

const utf8 = new TextEncoder();

function rgb(hex: string): [number, number, number] {
  const v = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!v) return [0, 0, 0];
  const n = parseInt(v[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const label = (s: string) => utf8.encode(s).slice(0, 255);

/** quickCues: eight hot cue slots (empty ones at sample -1), then the main cue. */
export function quickCues(t: ExportTrack): Uint8Array {
  const slots = Array.from({ length: 8 }, (_, i) => t.hotCues.find((c) => c.index === i));
  const labels = slots.map((c) => label(c?.name ?? ""));
  const b = new Bytes(25 + 13 * 8 + labels.reduce((n, l) => n + l.length, 0)).i64(8);
  slots.forEach((c, i) => {
    b.u8(labels[i].length).raw(labels[i]);
    if (!c) {
      b.f64(-1).u8(0).u8(0).u8(0).u8(0);
    } else {
      const [r, g, bl] = rgb(c.color);
      b.f64(at(t, c.time)).u8(255).u8(r).u8(g).u8(bl);
    }
  });
  const main = t.cue !== undefined ? at(t, t.cue) : 0;
  return b.f64(main).u8(1).f64(main).done();
}

/** loops: eight saved-loop slots. Little-endian and not compressed, unlike the others. */
export function loops(t: ExportTrack): Uint8Array {
  const saved = t.hotCues.filter((c) => c.loopEnd !== undefined && c.loopEnd > c.time).slice(0, 8);
  const slots = Array.from({ length: 8 }, (_, i) => saved[i]);
  const labels = slots.map((c) => label(c?.name ?? ""));
  const b = new Bytes(8 + 23 * 8 + labels.reduce((n, l) => n + l.length, 0)).i64(8, true);
  slots.forEach((c, i) => {
    b.u8(labels[i].length).raw(labels[i]);
    if (!c) {
      b.f64(-1, true).f64(-1, true).u8(0).u8(0).u8(0).u8(0).u8(0).u8(0);
    } else {
      const [r, g, bl] = rgb(c.color);
      b.f64(at(t, c.time), true).f64(at(t, c.loopEnd!), true).u8(1).u8(1).u8(255).u8(r).u8(g).u8(bl);
    }
  });
  return b.done();
}

const OVERVIEW_POINTS = 1024;

/** overviewWaveFormData: 1024 points of low, mid and high, and their maxima. */
export function overviewWaveform(t: ExportTrack, waveform: Uint8Array | undefined, columnsPerS: number): Uint8Array {
  const qn = Math.floor(t.sampleRate / 210) * 2;
  const samples = frames(t);
  if (!waveform || !waveform.length || !qn || !samples) {
    return new Bytes(27).i64(0).i64(0).f64(0).u8(0).u8(0).u8(0).done();
  }
  const perPoint = (Math.floor(samples / qn) * qn) / OVERVIEW_POINTS;
  const level = (v: number) => Math.round(Math.min(1, v * 1.3) * 255);
  const points = evenly(new Columns(waveform, columnsPerS), t.duration, OVERVIEW_POINTS).map((p: Bands) => [
    level(p.low),
    level(p.mid),
    level(p.high),
  ]);
  const b = new Bytes(27 + 3 * OVERVIEW_POINTS).i64(OVERVIEW_POINTS).i64(OVERVIEW_POINTS).f64(perPoint);
  const max = [0, 0, 0];
  for (const p of points) {
    p.forEach((v, k) => {
      b.u8(v);
      max[k] = Math.max(max[k], v);
    });
  }
  return b.u8(max[0]).u8(max[1]).u8(max[2]).done();
}

// --- The database ---------------------------------------------------------------------

/** "YYYY-MM-DD HH:MM:SS", as Engine stores list edit times. */
function timestamp(d = new Date()): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/** Where Engine finds a track: relative to the `Engine Library` folder. */
export function enginePath(filePath: string): string {
  return `..${filePath}`;
}

export interface EngineInput {
  library: ExportLibrary;
  /** Waveform of each track (`waveforms[i]` for `library.tracks[i]`), and its columns per second. */
  waveform: (i: number) => Promise<Uint8Array | undefined>;
  columnsPerS: number;
  progress?: (done: number, total: number) => void;
}

/** Builds `m.db`. */
export async function engineDatabase(input: EngineInput): Promise<Uint8Array> {
  const SQL = await sqlite();
  const db: Database = new SQL.Database();
  try {
    for (const line of schemaSql.split("\n")) {
      if (line.trim() && !line.startsWith("--")) db.run(line);
    }
    const uuid = crypto.randomUUID();
    // libdjinterop: "Not yet sure how the currentPlayedIndiciator value is formed" (random).
    const played = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    db.run(
      "INSERT INTO Information (uuid, schemaVersionMajor, schemaVersionMinor, schemaVersionPatch, " +
        "currentPlayedIndiciator, lastRekordBoxLibraryImportReadCounter) VALUES (?, ?, ?, ?, ?, 0)",
      [uuid, SCHEMA.major, SCHEMA.minor, SCHEMA.patch, played],
    );
    db.run("INSERT INTO AlbumArt VALUES (1, '', NULL)");

    const insertTrack = db.prepare(
      "INSERT INTO Track (playOrder, length, bpm, year, path, filename, bitrate, bpmAnalyzed, albumArtId, " +
        "fileBytes, title, artist, album, genre, comment, label, composer, remixer, key, rating, albumArt, " +
        "timeLastPlayed, isPlayed, fileType, isAnalyzed, dateCreated, dateAdded, isAvailable, " +
        "isMetadataOfPackedTrackChanged, isPerfomanceDataOfPackedTrackChanged, playedIndicator, " +
        "isMetadataImported, pdbImportKey, streamingSource, uri, isBeatGridLocked, originDatabaseUuid, " +
        "originTrackId, streamingFlags, explicitLyrics, lastEditTime) VALUES " +
        "(NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL, 0, ?, 1, ?, ?, 1, " +
        "0, 0, NULL, 1, 0, NULL, NULL, ?, ?, 0, 0, 0, ?)",
    );
    const updatePerformance = db.prepare(
      "UPDATE PerformanceData SET trackData = ?, overviewWaveFormData = ?, beatData = ?, quickCues = ?, " +
        "loops = ?, thirdPartySourceId = NULL, activeOnLoadLoops = 0 WHERE trackId = ?",
    );
    const ids: number[] = [];
    const { tracks } = input.library;
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const filename = t.filePath.split("/").pop() ?? "";
      insertTrack.run([
        Math.round(t.duration),
        t.bpm > 0 ? Math.floor(t.bpm) : null,
        t.year || null,
        enginePath(t.filePath),
        filename,
        t.bitrate || null,
        t.bpm > 0 ? t.bpm : null,
        t.fileSize,
        t.title || null,
        t.artist || null,
        t.album || null,
        t.genre || null,
        t.comment || null,
        t.label || null,
        t.engineKey ?? null,
        Math.max(0, Math.min(5, t.rating)) * 20,
        t.fileType,
        t.added || now,
        t.added || now,
        t.bpm > 0 ? 1 : 0,
        uuid,
        now,
      ]);
      const id = db.exec("SELECT last_insert_rowid()")[0].values[0][0] as number;
      ids.push(id);
      const waveform = await input.waveform(i);
      updatePerformance.run([
        await qCompress(trackData(t)),
        await qCompress(overviewWaveform(t, waveform, input.columnsPerS)),
        await qCompress(beatData(t)),
        await qCompress(quickCues(t)),
        loops(t),
        id,
      ]);
      input.progress?.(i + 1, tracks.length);
    }
    insertTrack.free();
    updatePerformance.free();

    // Playlists: folders are playlists with children. Inserting with nextListId 0
    // appends to the parent's list; the schema's triggers relink the others.
    const insertList = db.prepare(
      "INSERT INTO Playlist (title, parentListId, isPersisted, nextListId, lastEditTime, isExplicitlyExported) " +
        "VALUES (?, ?, 1, 0, ?, 1)",
    );
    const lists = new Map<string, number>();
    const listId = (path: string[]): number => {
      if (path.length === 0) return 0;
      const key = JSON.stringify(path);
      const known = lists.get(key);
      if (known !== undefined) return known;
      const parent = listId(path.slice(0, -1));
      insertList.run([path[path.length - 1], parent, timestamp()]);
      const id = db.exec("SELECT last_insert_rowid()")[0].values[0][0] as number;
      lists.set(key, id);
      return id;
    };
    const insertEntity = db.prepare(
      "INSERT INTO PlaylistEntity (listId, trackId, databaseUuid, nextEntityId, membershipReference) " +
        "VALUES (?, ?, ?, 0, 0)",
    );
    const linkPrevious = db.prepare(
      "UPDATE PlaylistEntity SET nextEntityId = ? WHERE listId = ? AND nextEntityId = 0 AND id <> ?",
    );
    for (const p of input.library.playlists) {
      const list = listId([...p.folders, p.name]);
      const seen = new Set<number>();
      for (const i of p.tracks) {
        const trackId = ids[i];
        // A track appears once per Engine playlist (a constraint of the schema).
        if (trackId === undefined || seen.has(trackId)) continue;
        seen.add(trackId);
        insertEntity.run([list, trackId, uuid]);
        const id = db.exec("SELECT last_insert_rowid()")[0].values[0][0] as number;
        linkPrevious.run([id, list, id]);
      }
    }
    insertList.free();
    insertEntity.free();
    linkPrevious.free();
    return db.export();
  } finally {
    db.close();
  }
}
