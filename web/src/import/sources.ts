// Each app's library as an ImportedLibrary: what to pick, where to find it, and how to
// read it. The readers live beside this file; this one finds their files.

import { parseKey } from "../lib/keys";
import { sqlite } from "../lib/sqlite";
import { HOT_CUE_COLORS, type Cue } from "../lib/types";
import { pool } from "../state/app";
import { addFolderFromHandle } from "../state/library";
import { readEngineDatabase } from "./engine";
import type { PickedFolder } from "./folder";
import { readMixxxDatabase } from "./mixxx";
import { baseName, type ImportedLibrary, type ImportedTrack, type ImportProgress, noHotCues } from "./model";
import { parseRekordboxXml } from "./rekordbox";
import { seratoLibrary } from "./serato";
import { parseTraktorNml } from "./traktor";
import { virtualDjLibrary } from "./virtualdj";

const bytes = async (f: File) => new Uint8Array(await f.arrayBuffer());

// --- Files -----------------------------------------------------------------------------

export async function fromRekordboxXml(file: File): Promise<ImportedLibrary> {
  return parseRekordboxXml(await file.text(), HOT_CUE_COLORS);
}

export async function fromTraktor(file: File): Promise<ImportedLibrary> {
  return parseTraktorNml(await file.text());
}

export async function fromMixxx(file: File): Promise<ImportedLibrary> {
  return readMixxxDatabase(await bytes(file), await sqlite());
}

// --- Folders ---------------------------------------------------------------------------

/** `_Serato_` itself, or the folder (or drive) that holds it. */
export async function fromSerato(folder: PickedFolder): Promise<ImportedLibrary> {
  let base = "";
  let database = await folder.file("database V2");
  if (!database) {
    base = "_Serato_/";
    database = await folder.file(`${base}database V2`);
  }
  if (!database) throw new Error(`No "database V2" in ${folder.name}. Pick the _Serato_ folder (in your Music folder, or at the top of a drive).`);
  const crates = [];
  for (const name of await folder.list(`${base}Subcrates`)) {
    if (!name.toLowerCase().endsWith(".crate")) continue;
    const f = await folder.file(`${base}Subcrates/${name}`);
    if (f) crates.push({ name, data: await bytes(f) });
  }
  return seratoLibrary({ database: await bytes(database), crates });
}

/** The VirtualDJ folder (Documents/VirtualDJ): database.xml and "My Lists". */
export async function fromVirtualDj(folder: PickedFolder): Promise<ImportedLibrary> {
  const database = await folder.file("database.xml");
  if (!database) throw new Error(`No database.xml in ${folder.name}. Pick the VirtualDJ folder in Documents.`);
  const lists = [];
  for (const name of await folder.list("My Lists")) {
    if (!name.toLowerCase().endsWith(".xml")) continue;
    const f = await folder.file(`My Lists/${name}`);
    if (f) lists.push({ name, text: await f.text() });
  }
  return virtualDjLibrary(await database.text(), lists);
}

/** "Engine Library" (on the computer or a stick), or the stick that holds one. */
export async function fromEngine(folder: PickedFolder, libraryIds?: Map<string, string>): Promise<ImportedLibrary | undefined> {
  let base = "";
  let db = await folder.file("Database2/m.db");
  if (!db) {
    base = "Engine Library/";
    db = await folder.file(`${base}Database2/m.db`);
  }
  if (!db) return undefined;
  const lib = await readEngineDatabase(await bytes(db), await sqlite());
  if (libraryIds) {
    for (const t of lib.tracks) t.libraryId = libraryIds.get(resolve(base, t.location));
  }
  return lib;
}

/** A path relative to `base` ("Engine Library/" + "../Contents/a.mp3"), from the root. */
function resolve(base: string, path: string): string {
  const out: string[] = base.split("/").filter(Boolean);
  for (const p of path.replace(/\\/g, "/").split("/")) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/").normalize("NFC").toLowerCase();
}

// --- USB sticks --------------------------------------------------------------------------

/** Files packed for the worker: per file a u32 path length, the path, a u32 length, the bytes. */
function bundle(files: [string, Uint8Array][]): ArrayBuffer {
  const enc = new TextEncoder();
  const named = files.map(([p, b]) => [enc.encode(p), b] as const);
  const out = new Uint8Array(named.reduce((n, [p, b]) => n + 8 + p.length + b.length, 0));
  const v = new DataView(out.buffer);
  let o = 0;
  for (const [p, b] of named) {
    v.setUint32(o, p.length, true);
    out.set(p, o + 4);
    o += 4 + p.length;
    v.setUint32(o, b.length, true);
    out.set(b, o + 4);
    o += 4 + b.length;
  }
  return out.buffer;
}

interface StickTrack {
  id: number;
  filePath: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  comment: string;
  key: string;
  bpm: number;
  fileSize: number;
  rating: number;
  playCount: number;
  analysisPath: string;
}
interface StickCue {
  hotCue: number;
  time: number;
  loopEnd: number | null;
  color: string | null;
  name: string;
}

async function fromPioneerStick(
  folder: PickedFolder,
  libraryIds: Map<string, string> | undefined,
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportedLibrary | undefined> {
  const pdb = await folder.file("PIONEER/rekordbox/export.pdb");
  if (!pdb) return undefined;
  const ext = await folder.file("PIONEER/rekordbox/exportExt.pdb");
  const files: [string, Uint8Array][] = [["export.pdb", await bytes(pdb)]];
  if (ext) files.push(["exportExt.pdb", await bytes(ext)]);
  const read = await pool.run({ op: "pioneerRead", bytes: bundle(files), ext: "", bpmRange: [0, 0], columnsPerS: 0 });
  const stick = read.json as { tracks: StickTrack[]; playlists: { name: string; trackIds: number[] }[] };

  const tracks: ImportedTrack[] = [];
  for (let i = 0; i < stick.tracks.length; i++) {
    const s = stick.tracks[i];
    if (i % 10 === 0) onProgress?.({ phase: "Reading the stick's cues", done: i, total: stick.tracks.length });
    const rel = s.filePath.replace(/^\/+/, "");
    const t: ImportedTrack = {
      id: String(s.id),
      fileName: baseName(s.filePath),
      location: s.filePath,
      size: s.fileSize || undefined,
      libraryId: libraryIds?.get(rel.normalize("NFC").toLowerCase()),
      title: s.title,
      artist: s.artist,
      album: s.album,
      genre: s.genre,
      comment: s.comment,
      rating: s.rating,
      playCount: s.playCount,
      key: parseKey(s.key),
      bpm: s.bpm > 0 ? s.bpm : undefined,
    };
    const dat = s.analysisPath && (await folder.file(s.analysisPath));
    if (dat) {
      const extFile = await folder.file(s.analysisPath.replace(/\.DAT$/i, ".EXT"));
      const parts: [string, Uint8Array][] = [["DAT", await bytes(dat)]];
      if (extFile) parts.push(["EXT", await bytes(extFile)]);
      try {
        const r = await pool.run({ op: "pioneerReadAnalysis", bytes: bundle(parts), ext: "", bpmRange: [0, 0], columnsPerS: 0 });
        const a = r.json as { bpm: number | null; anchor: number | null; cues: StickCue[] };
        if (a.bpm && a.anchor !== null) {
          t.bpm = a.bpm;
          t.anchor = a.anchor;
        }
        const hot = noHotCues();
        const memory: Cue[] = [];
        for (const c of a.cues) {
          const cue: Cue = { time: c.time, color: c.color ?? (c.hotCue > 0 ? HOT_CUE_COLORS[(c.hotCue - 1) % 8] : "#ff3d3d") };
          if (c.name) cue.name = c.name;
          if (c.loopEnd !== null) cue.loopEnd = c.loopEnd;
          if (c.hotCue >= 1 && c.hotCue <= 8) hot[c.hotCue - 1] = cue;
          else memory.push(cue);
        }
        if (hot.some(Boolean)) t.hotCues = hot;
        if (memory.length) {
          t.memoryCues = memory;
          t.cue = memory[0].time;
        }
      } catch {
        /* the track still comes across without its cues */
      }
    }
    tracks.push(t);
  }
  return {
    source: "rekordbox USB",
    tracks,
    playlists: stick.playlists.map((p) => ({ name: p.name, trackIds: p.trackIds.map(String) })),
  };
}

/** A stick prepared in rekordbox and/or Engine DJ. With `addMusic`, its music joins the
 * library first, so every track on it matches. */
export async function fromStick(
  folder: PickedFolder,
  addMusic: boolean,
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportedLibrary[]> {
  let libraryIds: Map<string, string> | undefined;
  if (addMusic && folder.handle) {
    onProgress?.({ phase: "Adding the stick's music", done: 0, total: 1 });
    const ids = await addFolderFromHandle(folder.handle);
    libraryIds = new Map(ids.map((id) => [id.slice(id.indexOf("/") + 1).normalize("NFC").toLowerCase(), id]));
  }
  const out: ImportedLibrary[] = [];
  const pioneer = await fromPioneerStick(folder, libraryIds, onProgress);
  if (pioneer) out.push(pioneer);
  const engine = await fromEngine(folder, libraryIds);
  if (engine) {
    // A stick with both libraries describes the same files twice: the rekordbox one has
    // more (memory cues), so Engine's tracks bring only their playlists.
    if (pioneer) {
      const known = new Set(pioneer.tracks.map((t) => t.location.replace(/^\/+/, "").normalize("NFC").toLowerCase()));
      engine.tracks = engine.tracks.map((t) =>
        known.has(resolve("Engine Library/", t.location))
          ? { id: t.id, fileName: t.fileName, location: t.location, size: t.size, libraryId: t.libraryId }
          : t,
      );
    }
    out.push(engine);
  }
  if (!out.length) {
    throw new Error(`${folder.name} has no rekordbox (PIONEER/rekordbox/export.pdb) or Engine DJ (Engine Library) library.`);
  }
  return out;
}
