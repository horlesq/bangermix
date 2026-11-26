// Reads Mixxx's library (mixxxdb.sqlite): tracks with their grids (a protobuf blob),
// hot cues, saved loops and main cue, playlists and crates. Positions as Mixxx stores
// them: beats in frames, cues in interleaved stereo samples (frames × 2).

import type { Database, SqlJsStatic } from "sql.js";
import { parseKey } from "../lib/keys";
import type { Cue } from "../lib/types";
import { hexColor, type ImportedLibrary, type ImportedPlaylist, type ImportedTrack, noHotCues } from "./model";

/** The fields of a protobuf message: number → values (numbers or bytes). */
function protobuf(b: Uint8Array): Map<number, (number | Uint8Array)[]> {
  const out = new Map<number, (number | Uint8Array)[]>();
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  const varint = () => {
    let x = 0;
    let shift = 1;
    for (;;) {
      const byte = b[o++];
      x += (byte & 0x7f) * shift;
      shift *= 128;
      if (!(byte & 0x80) || o >= b.length) return x;
    }
  };
  while (o < b.length) {
    const key = varint();
    const field = Math.floor(key / 8);
    let value: number | Uint8Array;
    switch (key & 7) {
      case 0:
        value = varint();
        break;
      case 1:
        value = v.getFloat64(o, true);
        o += 8;
        break;
      case 2: {
        const n = varint();
        value = b.subarray(o, o + n);
        o += n;
        break;
      }
      case 5:
        value = v.getFloat32(o, true);
        o += 4;
        break;
      default:
        return out;
    }
    out.set(field, [...(out.get(field) ?? []), value]);
  }
  return out;
}

const bytesOf = (m: Map<number, (number | Uint8Array)[]>, f: number) => m.get(f)?.find((x) => x instanceof Uint8Array) as Uint8Array | undefined;
const numberOf = (m: Map<number, (number | Uint8Array)[]>, f: number) => m.get(f)?.find((x) => typeof x === "number") as number | undefined;

/** BeatGrid-2.0: { bpm: { bpm: double }, first_beat: { frame_position: int32 } }.
 * BeatMap-1.0: { repeated beat: { frame_position } }. */
export function readMixxxBeats(blob: Uint8Array, version: string, sampleRate: number): { bpm: number; anchor: number } | undefined {
  if (!(sampleRate > 0)) return undefined;
  const m = protobuf(blob);
  if (version.startsWith("BeatGrid")) {
    const bpmMsg = bytesOf(m, 1);
    const first = bytesOf(m, 2);
    const bpm = bpmMsg && numberOf(protobuf(bpmMsg), 1);
    const frame = first ? (numberOf(protobuf(first), 1) ?? 0) : 0;
    return bpm && bpm > 0 ? { bpm, anchor: frame / sampleRate } : undefined;
  }
  if (version.startsWith("BeatMap")) {
    const beats = (m.get(1) ?? [])
      .filter((x): x is Uint8Array => x instanceof Uint8Array)
      .map((b) => numberOf(protobuf(b), 1) ?? 0)
      .sort((a, b) => a - b);
    if (beats.length < 2) return undefined;
    const span = beats[beats.length - 1] - beats[0];
    const bpm = (60 * sampleRate * (beats.length - 1)) / span;
    return Number.isFinite(bpm) && bpm > 0 ? { bpm, anchor: beats[0] / sampleRate } : undefined;
  }
  return undefined;
}

/** Mixxx's key ids: 1–12 C major … B major, 13–24 C minor … B minor. */
export function mixxxKey(id: number | undefined) {
  if (!id || id < 1 || id > 24) return undefined;
  return { tonic: (id - 1) % 12, minor: id > 12 };
}

type Row = Record<string, unknown>;
const rows = (db: Database, sql: string): Row[] => {
  const res = db.exec(sql)[0];
  return res ? res.values.map((v) => Object.fromEntries(res.columns.map((c, i) => [c, v[i]]))) : [];
};
const str = (x: unknown) => (typeof x === "string" ? x : x === null || x === undefined ? "" : String(x));
const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
const color = (c: unknown) => {
  const x = n(c) ?? 0xff3d3d;
  return hexColor((x >> 16) & 255, (x >> 8) & 255, x & 255);
};

export function readMixxxDatabase(bytes: Uint8Array, SQL: SqlJsStatic): ImportedLibrary {
  let db: Database;
  try {
    db = new SQL.Database(bytes);
    db.exec("SELECT 1 FROM library LIMIT 1; SELECT 1 FROM track_locations LIMIT 1");
  } catch {
    throw new Error("This is not a Mixxx library (mixxxdb.sqlite).");
  }
  try {
    const cols = new Set(rows(db, "PRAGMA table_info(library)").map((r) => String(r.name)));
    const keyId = cols.has("key_id") ? "l.key_id" : "NULL AS key_id";
    const list = rows(
      db,
      `SELECT l.id, l.title, l.artist, l.album, l.genre, l.comment, l.rating, l.timesplayed, l.bpm, l.key, ${keyId},
              l.samplerate, l.beats, l.beats_version, tl.location, tl.filename, tl.filesize
       FROM library l JOIN track_locations tl ON tl.id = l.location
       WHERE l.mixxx_deleted = 0 AND tl.fs_deleted = 0`,
    );
    const cues = new Map<string, Row[]>();
    for (const c of rows(db, "SELECT track_id, type, position, length, hotcue, label, color FROM cues")) {
      const k = String(c.track_id);
      cues.set(k, [...(cues.get(k) ?? []), c]);
    }
    const tracks: ImportedTrack[] = list.map((r) => {
      const id = String(r.id);
      const rate = n(r.samplerate) ?? 44100;
      const t: ImportedTrack = {
        id,
        fileName: str(r.filename),
        location: str(r.location),
        size: n(r.filesize),
        title: str(r.title),
        artist: str(r.artist),
        album: str(r.album),
        genre: str(r.genre),
        comment: str(r.comment),
        rating: n(r.rating) ?? 0,
        playCount: n(r.timesplayed) ?? 0,
        key: mixxxKey(n(r.key_id)) ?? parseKey(str(r.key)),
      };
      const bpm = n(r.bpm);
      if (bpm && bpm > 0) t.bpm = bpm;
      if (r.beats instanceof Uint8Array) {
        const g = readMixxxBeats(r.beats, str(r.beats_version), rate);
        if (g) {
          t.bpm = g.bpm;
          t.anchor = g.anchor;
        }
      }
      const hot = noHotCues();
      const memory: Cue[] = [];
      for (const c of cues.get(id) ?? []) {
        const type = n(c.type);
        const time = (n(c.position) ?? -1) / 2 / rate;
        if (time < 0) continue;
        if (type === 2) {
          t.cue = time;
          continue;
        }
        if (type !== 1 && type !== 4) continue;
        const cue: Cue = { time, color: color(c.color) };
        const label = str(c.label);
        if (label) cue.name = label;
        const len = (n(c.length) ?? 0) / 2 / rate;
        if (type === 4 && len > 0) cue.loopEnd = time + len;
        const index = n(c.hotcue) ?? -1;
        if (index >= 0 && index < 8) hot[index] = cue;
        else memory.push(cue);
      }
      if (hot.some(Boolean)) t.hotCues = hot;
      if (memory.length) t.memoryCues = memory.sort((a, b) => a.time - b.time);
      return t;
    });

    const playlists: ImportedPlaylist[] = [];
    // hidden: 0 for the DJ's playlists (1 is Auto DJ, 2 the history).
    for (const p of rows(db, "SELECT id, name FROM Playlists WHERE hidden = 0 ORDER BY position, id")) {
      const ids = rows(db, `SELECT track_id FROM PlaylistTracks WHERE playlist_id = ${Number(p.id)} ORDER BY position`).map((r) => String(r.track_id));
      playlists.push({ name: str(p.name), trackIds: ids });
    }
    for (const c of rows(db, "SELECT id, name FROM crates ORDER BY name")) {
      const ids = rows(db, `SELECT track_id FROM crate_tracks WHERE crate_id = ${Number(c.id)}`).map((r) => String(r.track_id));
      playlists.push({ name: `Crates / ${str(c.name)}`, trackIds: ids });
    }
    return { source: "Mixxx", tracks, playlists };
  } finally {
    db.close();
  }
}
