// Reads Serato DJ's library: `_Serato_/database V2` (the tracks), `_Serato_/Subcrates/*.crate`
// (the crates, "Parent%%Child.crate" for nested ones), and the cues, saved loops and beat
// grid Serato keeps in each audio file's own tags ("Serato Markers2", "Serato BeatGrid").
//
// Formats as documented by Jan Holthuis (github.com/Holzhaus/serato-tags) and read by
// Mixxx: the database and crates are records of a 4-character tag, a big-endian u32
// length and the data, strings in UTF-16BE.

import { parseKey } from "../lib/keys";
import type { Cue } from "../lib/types";
import { baseName, hexColor, type ImportedLibrary, type ImportedPlaylist, type ImportedTrack, noHotCues } from "./model";

// --- database V2 and crates ------------------------------------------------------------

interface Field {
  tag: string;
  data: Uint8Array;
}

function* fields(b: Uint8Array): Generator<Field> {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 0;
  while (o + 8 <= b.length) {
    const tag = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    const len = v.getUint32(o + 4, false);
    if (o + 8 + len > b.length) return;
    yield { tag, data: b.subarray(o + 8, o + 8 + len) };
    o += 8 + len;
  }
}

const utf16 = new TextDecoder("utf-16be");
const text = (d: Uint8Array) => utf16.decode(d).replace(/\0+$/, "");

/** A Serato path as stored (relative to the drive or volume root, "/" separated). */
const pathKey = (p: string) => p.replace(/\\/g, "/").replace(/^\/+/, "").normalize("NFC").toLowerCase();

export function parseSeratoDatabase(bytes: Uint8Array): ImportedTrack[] {
  const tracks: ImportedTrack[] = [];
  let sawVersion = false;
  for (const f of fields(bytes)) {
    if (f.tag === "vrsn") sawVersion = true;
    if (f.tag !== "otrk") continue;
    const t: Record<string, string> = {};
    for (const g of fields(f.data)) if (g.tag[0] === "t" || g.tag[0] === "p") t[g.tag] = text(g.data);
    const path = t.pfil;
    if (!path) continue;
    const bpm = Number(t.tbpm);
    tracks.push({
      id: pathKey(path),
      fileName: baseName(path),
      location: path,
      title: t.tsng ?? "",
      artist: t.tart ?? "",
      album: t.talb ?? "",
      genre: t.tgen ?? "",
      comment: t.tcom ?? "",
      bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : undefined,
      key: parseKey(t.tkey),
    });
  }
  if (!sawVersion) throw new Error("This is not a Serato database (database V2).");
  return tracks;
}

/** A crate's tracks (as database ids). */
export function parseSeratoCrate(bytes: Uint8Array): string[] {
  const ids: string[] = [];
  for (const f of fields(bytes)) {
    if (f.tag !== "otrk") continue;
    for (const g of fields(f.data)) if (g.tag === "ptrk") ids.push(pathKey(text(g.data)));
  }
  return ids;
}

/** "Parent%%Child.crate" → "Parent / Child". */
export const crateName = (fileName: string) => fileName.replace(/\.crate$/i, "").split("%%").join(" / ");

// --- Markers2 and BeatGrid -------------------------------------------------------------

/** Serato stores a hot cue's colour from one palette and shows the one at the same
 * place in another. */
const STORED = [
  0xcc0000, 0xcc4400, 0xcc8800, 0xcccc00, 0x88cc00, 0x44cc00, 0x00cc00, 0x00cc44, 0x00cc88, 0x00cccc, 0x0088cc, 0x0044cc,
  0x0000cc, 0x4400cc, 0x8800cc, 0xcc00cc, 0xcc0088, 0xcc0044,
];
const SHOWN = [
  0xc02626, 0xdb4e27, 0xf8821a, 0xfac313, 0x4eb648, 0x006838, 0x1fad26, 0x8dc63f, 0x2b3673, 0x1dbebd, 0x0f88ca, 0x16308b,
  0x173ba2, 0x5c3f97, 0x6823b6, 0xce359e, 0xdc1d49, 0xc71136,
];

export function seratoCueColor(r: number, g: number, b: number): string {
  const rgb = (r << 16) | (g << 8) | b;
  const i = STORED.indexOf(rgb);
  const c = i >= 0 ? SHOWN[i] : rgb;
  return hexColor((c >> 16) & 255, (c >> 8) & 255, c & 255);
}

/** Base64 as Serato writes it: wrapped lines, sometimes no padding, NUL-filled. */
export function looseBase64(s: string | Uint8Array): Uint8Array {
  let str = typeof s === "string" ? s : new TextDecoder("latin1").decode(s);
  const nul = str.indexOf("\0");
  if (nul >= 0) str = str.slice(0, nul);
  str = str.replace(/[^A-Za-z0-9+/]/g, "");
  if (str.length % 4 === 1) str = str.slice(0, -1);
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface SeratoMarkers {
  hotCues: (Cue | null)[];
  loops: Cue[];
}

const utf8 = new TextDecoder();
const cString = (b: Uint8Array, from: number) => {
  const end = b.indexOf(0, from);
  return utf8.decode(b.subarray(from, end < 0 ? b.length : end));
};

/** The "Serato Markers2" payload: `01 01`, then base64 of `01 01` and NUL-named entries. */
export function parseMarkers2(payload: Uint8Array): SeratoMarkers {
  const out: SeratoMarkers = { hotCues: noHotCues(), loops: [] };
  if (payload[0] !== 1 || payload[1] !== 1) return out;
  const d = looseBase64(payload.subarray(2));
  if (d[0] !== 1 || d[1] !== 1) return out;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let o = 2;
  while (o < d.length) {
    const nameEnd = d.indexOf(0, o);
    if (nameEnd < 0) break;
    const type = utf8.decode(d.subarray(o, nameEnd));
    if (!type) break;
    if (nameEnd + 5 > d.length) break;
    const len = v.getUint32(nameEnd + 1, false);
    const e = d.subarray(nameEnd + 5, nameEnd + 5 + len);
    o = nameEnd + 5 + len;
    const ev = new DataView(e.buffer, e.byteOffset, e.byteLength);
    if (type === "CUE" && e.length >= 13) {
      const index = e[1];
      const cue: Cue = { time: ev.getUint32(2, false) / 1000, color: seratoCueColor(e[7], e[8], e[9]) };
      const name = cString(e, 12);
      if (name) cue.name = name;
      if (index < 8) out.hotCues[index] = cue;
    } else if (type === "LOOP" && e.length >= 21) {
      const start = ev.getUint32(2, false) / 1000;
      const end = ev.getUint32(6, false) / 1000;
      if (end > start) {
        const cue: Cue = { time: start, loopEnd: end, color: hexColor(e[15], e[16], e[17]) };
        const name = cString(e, 20);
        if (name) cue.name = name;
        out.loops.push(cue);
      }
    }
  }
  return out;
}

export interface SeratoGrid {
  bpm: number;
  /** The first marker: a downbeat, in seconds. */
  anchor: number;
}

/** "Serato BeatGrid": `01 00`, a u32 count, markers of (f32 seconds, u32 beats to the next)
 * and a last one of (f32 seconds, f32 BPM). A grid with tempo changes becomes the
 * longest of its constant parts. */
export function parseBeatGrid(d: Uint8Array): SeratoGrid | undefined {
  if (d.length < 14 || d[0] !== 1 || d[1] !== 0) return undefined;
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const n = v.getUint32(2, false);
  if (n < 1 || 6 + 8 * n > d.length) return undefined;
  const pos = (i: number) => v.getFloat32(6 + 8 * i, false);
  const last = n - 1;
  const lastBpm = v.getFloat32(6 + 8 * last + 4, false);
  if (!(lastBpm > 0)) return undefined;
  let best: SeratoGrid = { bpm: lastBpm, anchor: pos(last) };
  let bestLength = 0;
  for (let i = 0; i < last; i++) {
    const beats = v.getUint32(6 + 8 * i + 4, false);
    const span = pos(i + 1) - pos(i);
    if (beats > 0 && span > 0 && span > bestLength) {
      bestLength = span;
      best = { bpm: (60 * beats) / span, anchor: pos(i) };
    }
  }
  return Number.isFinite(best.bpm) && best.anchor >= 0 ? best : undefined;
}

// --- Reading the tags from an audio file ------------------------------------------------

interface Raw {
  markers2?: Uint8Array;
  beatgrid?: Uint8Array;
}

const latin1 = new TextDecoder("latin1");
const ID3_PREFIX = (name: string) => `application/octet-stream\0\0Serato ${name}\0`;

/** From a base64 value that wraps an ID3 GEOB ("application/octet-stream", "Serato …"),
 * as FLAC and MP4 files carry them. */
function unwrap(b64: string, name: string): Uint8Array | undefined {
  const d = looseBase64(b64);
  const prefix = ID3_PREFIX(name);
  return latin1.decode(d.subarray(0, prefix.length)) === prefix ? d.subarray(prefix.length) : undefined;
}

const syncsafe = (b: Uint8Array, o: number) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];

/** GEOB frames of an ID3v2.3/2.4 tag. */
function readId3(tag: Uint8Array, raw: Raw) {
  if (latin1.decode(tag.subarray(0, 3)) !== "ID3") return;
  const major = tag[3];
  const size = syncsafe(tag, 6);
  let o = 10;
  if (tag[5] & 0x40) o += major === 4 ? syncsafe(tag, 10) : new DataView(tag.buffer, tag.byteOffset).getUint32(10) + 4;
  const end = Math.min(tag.length, 10 + size);
  while (o + 10 <= end) {
    const id = latin1.decode(tag.subarray(o, o + 4));
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const len = major === 4 ? syncsafe(tag, o + 4) : new DataView(tag.buffer, tag.byteOffset).getUint32(o + 4);
    const body = tag.subarray(o + 10, o + 10 + len);
    o += 10 + len;
    if (id !== "GEOB") continue;
    // encoding, MIME (latin-1), file name and description (in the encoding), data.
    let p = body.indexOf(0, 1) + 1;
    const wide = body[0] === 1 || body[0] === 2;
    const skipString = () => {
      if (!wide) {
        p = body.indexOf(0, p) + 1;
        return;
      }
      while (p + 1 < body.length && (body[p] || body[p + 1])) p += 2;
      p += 2;
    };
    skipString();
    const descStart = p;
    skipString();
    // Byte-order marks and the UTF-16 high bytes fall away from an ASCII description.
    const desc = latin1.decode(body.subarray(descStart, p)).replace(/[\0\xfe\xff]/g, "");
    const data = body.subarray(p);
    if (desc === "Serato Markers2") raw.markers2 = data;
    else if (desc === "Serato BeatGrid") raw.beatgrid = data;
  }
}

async function bytes(file: Blob, from: number, to: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(from, to).arrayBuffer());
}

async function readMp3(file: File, raw: Raw) {
  const head = await bytes(file, 0, 10);
  if (latin1.decode(head.subarray(0, 3)) !== "ID3") return;
  readId3(await bytes(file, 0, 10 + syncsafe(head, 6)), raw);
}

/** WAV and AIFF keep an ID3 tag in an "id3 " / "ID3 " chunk. */
async function readChunks(file: File, raw: Raw, littleEndian: boolean) {
  let o = 12;
  while (o + 8 <= file.size) {
    const h = await bytes(file, o, o + 8);
    const id = latin1.decode(h.subarray(0, 4));
    const len = new DataView(h.buffer).getUint32(4, littleEndian);
    if (id.toLowerCase() === "id3 ") {
      readId3(await bytes(file, o + 8, o + 8 + len), raw);
      return;
    }
    o += 8 + len + (len & 1);
  }
}

async function readFlac(file: File, raw: Raw) {
  let o = 4;
  for (let n = 0; n < 64 && o + 4 <= file.size; n++) {
    const h = await bytes(file, o, o + 4);
    const last = h[0] & 0x80;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 4) {
      const b = await bytes(file, o + 4, o + 4 + len);
      const v = new DataView(b.buffer);
      let p = 4 + v.getUint32(0, true);
      const count = v.getUint32(p, true);
      p += 4;
      for (let i = 0; i < count && p + 4 <= b.length; i++) {
        const l = v.getUint32(p, true);
        const c = utf8.decode(b.subarray(p + 4, p + 4 + l));
        p += 4 + l;
        const eq = c.indexOf("=");
        const key = c.slice(0, eq).toUpperCase();
        if (key === "SERATO_MARKERS_V2") raw.markers2 = unwrap(c.slice(eq + 1), "Markers2");
        else if (key === "SERATO_BEATGRID") raw.beatgrid = unwrap(c.slice(eq + 1), "BeatGrid");
      }
      return;
    }
    if (last) return;
    o += 4 + len;
  }
}

/** MP4: moov › udta › meta › ilst › "----" atoms with mean "com.serato.dj". */
async function readMp4(file: File, raw: Raw) {
  const atoms = async function* (from: number, to: number) {
    let o = from;
    while (o + 8 <= to) {
      const h = await bytes(file, o, o + 16);
      const v = new DataView(h.buffer);
      let size = v.getUint32(0);
      const type = latin1.decode(h.subarray(4, 8));
      let header = 8;
      if (size === 1) {
        size = Number(v.getBigUint64(8));
        header = 16;
      } else if (size === 0) size = to - o;
      if (size < header) return;
      yield { type, start: o + header, end: o + size };
      o += size;
    }
  };
  const child = async (from: number, to: number, type: string) => {
    for await (const a of atoms(from, to)) if (a.type === type) return a;
    return undefined;
  };
  const moov = await child(0, file.size, "moov");
  const udta = moov && (await child(moov.start, moov.end, "udta"));
  const meta = udta && (await child(udta.start, udta.end, "meta"));
  const ilst = meta && (await child(meta.start + 4, meta.end, "ilst"));
  if (!ilst) return;
  for await (const a of atoms(ilst.start, ilst.end)) {
    if (a.type !== "----") continue;
    const b = await bytes(file, a.start, a.end);
    let mean = "";
    let name = "";
    let value: Uint8Array | undefined;
    let o = 0;
    const v = new DataView(b.buffer);
    while (o + 8 <= b.length) {
      const size = v.getUint32(o);
      const type = latin1.decode(b.subarray(o + 4, o + 8));
      if (size < 8) break;
      if (type === "mean") mean = latin1.decode(b.subarray(o + 12, o + size));
      else if (type === "name") name = latin1.decode(b.subarray(o + 12, o + size));
      else if (type === "data") value = b.subarray(o + 16, o + size);
      o += size;
    }
    if (mean !== "com.serato.dj" || !value) continue;
    if (name === "markersv2") raw.markers2 = unwrap(latin1.decode(value), "Markers2");
    else if (name === "beatgrid") raw.beatgrid = unwrap(latin1.decode(value), "BeatGrid");
  }
}

/** MP3s decoded without trimming the encoder delay (as here) sit this much later than
 * Serato's positions (measured by Mixxx, which decodes the same way). */
async function mp3Offset(file: File): Promise<number> {
  const head = await bytes(file, 0, 10);
  let o = latin1.decode(head.subarray(0, 3)) === "ID3" ? 10 + syncsafe(head, 6) : 0;
  const b = await bytes(file, o, o + 4096);
  for (o = 0; o + 4 < b.length; o++) {
    if (b[o] === 0xff && (b[o + 1] & 0xe0) === 0xe0) {
      const version = (b[o + 1] >> 3) & 3;
      const rate = (b[o + 2] >> 2) & 3;
      const base = [44100, 48000, 32000][rate];
      if (!base) continue;
      const hz = version === 3 ? base : version === 2 ? base / 2 : base / 4;
      return hz === 48000 ? -0.024 : -0.026;
    }
  }
  return -0.026;
}

/** A file's Serato cues, saved loops and grid. */
export async function readSeratoTags(file: File): Promise<Partial<ImportedTrack>> {
  const raw: Raw = {};
  const head = latin1.decode(await bytes(file, 0, 12));
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  let offset = 0;
  if (head.startsWith("ID3") || ext === "mp3") {
    await readMp3(file, raw);
    offset = await mp3Offset(file);
  } else if (head.startsWith("fLaC")) await readFlac(file, raw);
  else if (head.startsWith("RIFF")) await readChunks(file, raw, true);
  else if (head.startsWith("FORM")) await readChunks(file, raw, false);
  else if (head.slice(4, 8) === "ftyp") await readMp4(file, raw);

  const out: Partial<ImportedTrack> = {};
  const shift = (c: Cue): Cue => ({
    ...c,
    time: Math.max(0, c.time + offset),
    ...(c.loopEnd !== undefined ? { loopEnd: c.loopEnd + offset } : {}),
  });
  if (raw.markers2) {
    const m = parseMarkers2(raw.markers2);
    if (m.hotCues.some(Boolean)) out.hotCues = m.hotCues.map((c) => (c ? shift(c) : null));
    if (m.loops.length) out.memoryCues = m.loops.map(shift);
  }
  if (raw.beatgrid) {
    const g = parseBeatGrid(raw.beatgrid);
    if (g) {
      out.bpm = g.bpm;
      out.anchor = Math.max(0, g.anchor + offset);
    }
  }
  return out;
}

// --- The library ------------------------------------------------------------------------

export interface SeratoFiles {
  database: Uint8Array;
  crates: { name: string; data: Uint8Array }[];
}

export function seratoLibrary(files: SeratoFiles): ImportedLibrary {
  const tracks = parseSeratoDatabase(files.database);
  const playlists: ImportedPlaylist[] = files.crates
    .map((c) => ({ name: crateName(c.name), trackIds: parseSeratoCrate(c.data) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { source: "Serato", tracks, playlists, fromFile: (_t, file) => readSeratoTags(file) };
}
