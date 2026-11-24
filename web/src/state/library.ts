// The music library: folders, tracks, playlists, background analysis.
//
// Tracks live in IndexedDB and in memory (a few thousand rows sort and filter in a
// blink, no database engine needed). Audio files are read from the folders the user
// picked (Chrome keeps their handles between visits) or from files dropped in.

import { createSignal } from "solid-js";
import * as db from "../lib/db";
import { parseKey } from "../lib/keys";
import {
  ANALYSIS_VERSION,
  AUDIO_EXTENSIONS,
  HOT_CUE_COLORS,
  type FolderRec,
  type PlaylistRec,
  type TrackRec,
} from "../lib/types";
import type { WorkerPool } from "../workers/pool";
import type { AnalysisResult } from "../workers/protocol";
import { settings } from "./settings";

export const WAVEFORM_COLUMNS_PER_S = 100;
const DROPPED = "dropped";

const byId = new Map<string, TrackRec>();
export const [tracks, setTracks] = createSignal<TrackRec[]>([]);
export const [folders, setFolders] = createSignal<FolderRec[]>([]);
export const [playlists, setPlaylists] = createSignal<PlaylistRec[]>([]);
/** Folder id → whether the browser lets us read it now. */
export const [access, setAccess] = createSignal<Record<string, PermissionState>>({});
export const [scanStatus, setScanStatus] = createSignal("");
export const [analysisProgress, setAnalysisProgress] = createSignal({ done: 0, total: 0 });

const droppedFiles = new Map<string, File>();
let pool: WorkerPool;

export function initLibrary(p: WorkerPool) {
  pool = p;
}

export function trackById(id: string): TrackRec | undefined {
  return byId.get(id);
}

// --- Keeping memory and IndexedDB in step ---------------------------------------

let refreshQueued = false;
function refresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    setTracks([...byId.values()]);
  }, 150);
}

const dirty = new Set<string>();
let saveQueued = false;
function save(id: string) {
  dirty.add(id);
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(async () => {
    saveQueued = false;
    const recs = [...dirty].map((i) => byId.get(i)).filter(Boolean);
    dirty.clear();
    await db.putMany("tracks", recs);
  }, 800);
}

export function updateTrack(id: string, patch: Partial<TrackRec>) {
  const t = byId.get(id);
  if (!t) return;
  const next = { ...t, ...patch };
  byId.set(id, next);
  save(id);
  refresh();
  trackListeners.forEach((f) => f(next));
}

const trackListeners = new Set<(t: TrackRec) => void>();
/** Called whenever a track record changes. */
export function onTrackChange(f: (t: TrackRec) => void): () => void {
  trackListeners.add(f);
  return () => trackListeners.delete(f);
}

export async function loadLibrary() {
  const [ts, fs, ps] = await Promise.all([
    db.getAll<TrackRec>("tracks"),
    db.getAll<FolderRec>("folders"),
    db.getAll<PlaylistRec>("playlists"),
  ]);
  for (const t of ts) byId.set(t.id, t);
  setTracks(ts);
  setFolders(fs);
  setPlaylists(ps.sort((a, b) => a.createdAt - b.createdAt));
  const acc: Record<string, PermissionState> = {};
  for (const f of fs) {
    if (f.handle) acc[f.id] = await permission(f.handle, false);
  }
  setAccess(acc);
  // Dropped files are gone after a reload: their rows stay, marked missing.
}

async function permission(handle: FileSystemHandle, ask: boolean): Promise<PermissionState> {
  const h = handle as FileSystemHandle & {
    queryPermission?: (o: object) => Promise<PermissionState>;
    requestPermission?: (o: object) => Promise<PermissionState>;
  };
  try {
    const mode = { mode: "read" };
    let state = h.queryPermission ? await h.queryPermission(mode) : "granted";
    if (state === "prompt" && ask && h.requestPermission) state = await h.requestPermission(mode);
    return state;
  } catch {
    return "denied";
  }
}

/** Asks again for access to a folder from an earlier visit (needs a click). */
export async function reconnect(folder: FolderRec) {
  if (!folder.handle) return;
  const state = await permission(folder.handle, true);
  setAccess({ ...access(), [folder.id]: state });
  if (state === "granted") void scanFolder(folder);
}

/** Every folder that needs a click to be readable again. */
export function foldersNeedingAccess(): FolderRec[] {
  return folders().filter((f) => f.handle && access()[f.id] !== "granted");
}

// --- Adding music -------------------------------------------------------------------

export const canPickFolders = typeof (window as any).showDirectoryPicker === "function";

export async function addFolder() {
  const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({
    id: "bangermix-music",
    mode: "read",
  });
  await addFolderHandle(handle);
}

async function addFolderHandle(handle: FileSystemDirectoryHandle) {
  for (const f of folders()) {
    if (f.handle && (await f.handle.isSameEntry(handle))) {
      setAccess({ ...access(), [f.id]: "granted" });
      return scanFolder(f);
    }
  }
  const folder: FolderRec = { id: `f${Date.now().toString(36)}`, name: handle.name, handle, addedAt: Date.now() };
  await db.put("folders", folder);
  setFolders([...folders(), folder]);
  setAccess({ ...access(), [folder.id]: "granted" });
  await scanFolder(folder);
}

export async function removeFolder(folder: FolderRec) {
  await db.del("folders", folder.id);
  setFolders(folders().filter((f) => f.id !== folder.id));
  for (const t of [...byId.values()]) {
    if (t.folderId === folder.id) {
      byId.delete(t.id);
      await db.del("tracks", t.id);
    }
  }
  refresh();
}

/** Files and folders dropped on the window (or picked with a file input). */
export async function addDropped(items: DataTransferItemList | File[]) {
  const files: File[] = [];
  if (Array.isArray(items)) {
    files.push(...items);
  } else {
    const handles: Promise<FileSystemHandle | null>[] = [];
    const plain: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind !== "file") continue;
      const getHandle = (item as any).getAsFileSystemHandle as (() => Promise<FileSystemHandle | null>) | undefined;
      if (getHandle) handles.push(getHandle.call(item));
      else {
        const f = item.getAsFile();
        if (f) plain.push(f);
      }
    }
    for (const h of await Promise.all(handles)) {
      if (!h) continue;
      if (h.kind === "directory") await addFolderHandle(h as FileSystemDirectoryHandle);
      else files.push(await (h as FileSystemFileHandle).getFile());
    }
    files.push(...plain);
  }
  const audio = files.filter((f) => AUDIO_EXTENSIONS.includes(extOf(f.name)));
  if (audio.length === 0) return;
  if (!folders().some((f) => f.id === DROPPED)) {
    const folder: FolderRec = { id: DROPPED, name: "Dropped files", addedAt: Date.now() };
    await db.put("folders", folder);
    setFolders([...folders(), folder]);
  }
  const found = audio.map((file) => {
    const id = `drop:${file.name}:${file.size}`;
    droppedFiles.set(id, file);
    return { id, path: file.name, file: async () => file };
  });
  await addFound(DROPPED, found);
}

interface Found {
  id: string;
  path: string;
  file: () => Promise<File>;
}

async function* walk(dir: FileSystemDirectoryHandle, prefix: string): AsyncGenerator<{ path: string; handle: FileSystemFileHandle }> {
  for await (const entry of (dir as any).values() as AsyncIterable<FileSystemHandle>) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") {
      if (!entry.name.startsWith(".")) yield* walk(entry as FileSystemDirectoryHandle, path);
    } else if (AUDIO_EXTENSIONS.includes(extOf(entry.name)) && !entry.name.startsWith("._")) {
      yield { path, handle: entry as FileSystemFileHandle };
    }
  }
}

export async function scanFolder(folder: FolderRec) {
  if (!folder.handle) return;
  setScanStatus(`Scanning ${folder.name}…`);
  const found: Found[] = [];
  try {
    for await (const { path, handle } of walk(folder.handle, "")) {
      found.push({ id: `${folder.id}/${path}`, path, file: () => handle.getFile() });
      if (found.length % 200 === 0) setScanStatus(`Scanning ${folder.name}… ${found.length} files`);
    }
  } catch (e) {
    console.warn("scan failed", e);
  }
  await addFound(folder.id, found);
}

async function addFound(folderId: string, found: Found[]) {
  const fresh = found.filter((f) => !byId.has(f.id));
  let done = 0;
  const batch: TrackRec[] = [];
  const work = async (f: Found) => {
    const file = await f.file();
    const rec = await readTags(folderId, f, file);
    byId.set(rec.id, rec);
    batch.push(rec);
    done++;
    if (done % 25 === 0) {
      setScanStatus(`Reading tags… ${done} / ${fresh.length}`);
      refresh();
    }
  };
  await parallel(fresh, 6, work);
  await db.putMany("tracks", batch);
  setScanStatus(fresh.length ? `Added ${fresh.length} tracks` : "");
  setTimeout(() => setScanStatus(""), 3000);
  refresh();
  void analyseMissing();
}

async function readTags(folderId: string, f: Found, file: File): Promise<TrackRec> {
  const ext = extOf(file.name);
  const base = file.name.replace(/\.[^.]+$/, "");
  const dash = base.split(" - ");
  const rec: TrackRec = {
    id: f.id,
    folderId,
    path: f.path,
    name: file.name,
    ext,
    size: file.size,
    mtime: file.lastModified,
    title: dash.length > 1 ? dash.slice(1).join(" - ") : base,
    artist: dash.length > 1 ? dash[0] : "",
    album: "",
    genre: "",
    comment: "",
    year: "",
    hotCues: Array(8).fill(null),
    memoryCues: [],
    rating: 0,
    playCount: 0,
    dateAdded: Date.now(),
  };
  for (const whole of [false, true]) {
    try {
      const bytes = await readHead(file, ext, whole);
      const { tags } = await pool.run({ op: "probe", bytes, ext, bpmRange: [0, 0], columnsPerS: 0 }, "low");
      if (!tags) break;
      if (tags.title) rec.title = tags.title;
      if (tags.artist) rec.artist = tags.artist;
      rec.album = tags.album ?? "";
      rec.genre = tags.genre ?? "";
      rec.comment = tags.comment ?? "";
      rec.year = (tags.year ?? "").slice(0, 4);
      rec.tagBpm = tags.bpm;
      rec.tagKey = tags.key;
      rec.key = parseKey(tags.key);
      if (tags.duration) rec.duration = tags.duration;
      if (tags.art && tags.art.length > 0) {
        await db.put("art", new Blob([tags.art as BlobPart], { type: tags.artType ?? "image/jpeg" }), f.id);
        rec.hasArt = true;
      }
      break;
    } catch {
      // A head too short for this file: try the whole file once.
    }
  }
  return rec;
}

/** Enough of the file for its tags: the ID3 block and a little after for MP3, the
 * whole file for MP4 (whose index may sit at the end). */
async function readHead(file: File, ext: string, whole: boolean): Promise<ArrayBuffer> {
  if (whole || ["m4a", "mp4", "aac"].includes(ext) || file.size < 512 * 1024) return file.arrayBuffer();
  let n = 512 * 1024;
  if (ext === "mp3") {
    const h = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) {
      const size = (h[6] << 21) | (h[7] << 14) | (h[8] << 7) | h[9];
      n = size + 10 + 256 * 1024;
    }
  } else if (ext === "flac") {
    n = 2 * 1024 * 1024;
  }
  return file.slice(0, Math.min(n, file.size)).arrayBuffer();
}

export async function fileFor(t: TrackRec): Promise<File> {
  const dropped = droppedFiles.get(t.id);
  if (dropped) return dropped;
  const folder = folders().find((f) => f.id === t.folderId);
  if (!folder?.handle) throw new Error("This file was dropped in during an earlier visit: drop it in again.");
  if ((await permission(folder.handle, true)) !== "granted") {
    throw new Error(`No access to the folder ${folder.name}: reconnect it in the browser.`);
  }
  let dir = folder.handle;
  const parts = t.path.split("/");
  for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
  const fh = await dir.getFileHandle(parts[parts.length - 1]);
  return fh.getFile();
}

export function isAvailable(t: TrackRec): boolean {
  if (t.folderId === DROPPED) return droppedFiles.has(t.id);
  return access()[t.folderId] === "granted";
}

// --- Analysis -----------------------------------------------------------------------

/** Stores an analysis (from a deck load or the background) on its track. */
export async function storeAnalysis(id: string, a: AnalysisResult, waveform: Uint8Array) {
  await db.put("waveforms", waveform, id);
  const t = byId.get(id);
  const patch: Partial<TrackRec> = {
    duration: a.duration,
    loudness: a.loudness,
    gridConfidence: a.gridConfidence,
    analysisVersion: ANALYSIS_VERSION,
    analysisError: undefined,
  };
  // Hand-edited grids and keys from tags win over the analysis.
  if (a.bpm > 0 && !(t?.bpm && t.analysisVersion === -1)) {
    patch.bpm = a.bpm;
    patch.anchor = a.anchor;
  }
  if (a.key && !t?.tagKey) patch.key = a.key;
  updateTrack(id, patch);
}

export async function waveformFor(id: string): Promise<Uint8Array | undefined> {
  return db.get<Uint8Array>("waveforms", id);
}

const artUrls = new Map<string, Promise<string | null>>();
export function artUrl(t: TrackRec): Promise<string | null> {
  if (!t.hasArt) return Promise.resolve(null);
  let p = artUrls.get(t.id);
  if (!p) {
    p = db.get<Blob>("art", t.id).then((b) => (b ? URL.createObjectURL(b) : null));
    artUrls.set(t.id, p);
  }
  return p;
}

export function needsAnalysis(t: TrackRec): boolean {
  return t.analysisVersion !== ANALYSIS_VERSION && t.analysisVersion !== -1 && !t.analysisError;
}

let analysing = false;
export async function analyseMissing() {
  if (analysing) return;
  analysing = true;
  try {
    for (;;) {
      const todo = [...byId.values()].filter((t) => needsAnalysis(t) && isAvailable(t));
      if (todo.length === 0) break;
      let done = 0;
      setAnalysisProgress({ done, total: todo.length });
      await parallel(todo, Math.max(1, poolSizeForBackground()), async (t) => {
        try {
          const file = await fileFor(t);
          const bytes = await file.arrayBuffer();
          const r = await pool.run(
            {
              op: "analyse",
              analyse: true,
              bytes,
              ext: t.ext,
              bpmRange: [settings.bpmMin, settings.bpmMax],
              columnsPerS: WAVEFORM_COLUMNS_PER_S,
            },
            "low",
          );
          if (r.analysis && r.waveform) await storeAnalysis(t.id, r.analysis, r.waveform);
        } catch (e) {
          const msg = String((e as Error).message ?? e);
          if (msg !== "cancelled") updateTrack(t.id, { analysisError: msg });
        }
        done++;
        setAnalysisProgress({ done, total: todo.length });
      });
    }
  } finally {
    analysing = false;
    setAnalysisProgress({ done: 0, total: 0 });
  }
}

function poolSizeForBackground(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(4, cores - 2) - 1);
}

/** Analyse a track again (after changing the BPM range, say). */
export function reanalyse(ids: string[]) {
  for (const id of ids) updateTrack(id, { analysisVersion: 0, analysisError: undefined });
  setTimeout(() => void analyseMissing(), 300);
}

// --- Playlists ----------------------------------------------------------------------

export async function createPlaylist(name: string): Promise<PlaylistRec> {
  const p: PlaylistRec = { id: `p${Date.now().toString(36)}`, name, trackIds: [], createdAt: Date.now() };
  await db.put("playlists", p);
  setPlaylists([...playlists(), p]);
  return p;
}

export async function savePlaylist(p: PlaylistRec) {
  await db.put("playlists", p);
  setPlaylists(playlists().map((x) => (x.id === p.id ? p : x)));
}

export async function deletePlaylist(p: PlaylistRec) {
  await db.del("playlists", p.id);
  setPlaylists(playlists().filter((x) => x.id !== p.id));
}

export async function addToPlaylist(p: PlaylistRec, ids: string[]) {
  const set = new Set(p.trackIds);
  await savePlaylist({ ...p, trackIds: [...p.trackIds, ...ids.filter((i) => !set.has(i))] });
}

// --- Importing from rekordbox -------------------------------------------------------

export interface ImportReport {
  inXml: number;
  matched: number;
  playlists: number;
  /** File names of tracks not found in the library (first few). */
  missing: string[];
  missingCount: number;
}

/** Applies a rekordbox.xml export to the library: grids, keys, cues, loops, ratings
 * and playlists. Tracks are matched by file name and size, so the music must be in
 * the library already (add its folder first). */
export async function importRekordbox(text: string): Promise<ImportReport> {
  const { parseRekordboxXml } = await import("../lib/rekordbox");
  const xml = parseRekordboxXml(text, HOT_CUE_COLORS);
  const byNameSize = new Map<string, TrackRec>();
  const byName = new Map<string, TrackRec[]>();
  for (const t of byId.values()) {
    const name = t.name.toLowerCase();
    byNameSize.set(`${name}|${t.size}`, t);
    byName.set(name, [...(byName.get(name) ?? []), t]);
  }
  const idMap = new Map<string, string>();
  const missing: string[] = [];
  for (const x of xml.tracks) {
    const name = x.fileName.toLowerCase();
    const sameName = byName.get(name) ?? [];
    const t = byNameSize.get(`${name}|${x.size}`) ?? (sameName.length === 1 ? sameName[0] : undefined);
    if (!t) {
      missing.push(x.fileName);
      continue;
    }
    idMap.set(x.id, t.id);
    const patch: Partial<TrackRec> = {
      rating: x.rating || t.rating,
      playCount: Math.max(t.playCount, x.playCount),
      hotCues: x.hotCues.some(Boolean) ? x.hotCues : t.hotCues,
      memoryCues: x.memoryCues.length ? x.memoryCues : t.memoryCues,
    };
    if (x.comment && !t.comment) patch.comment = x.comment;
    if (x.genre && !t.genre) patch.genre = x.genre;
    if (x.key) patch.key = x.key;
    if (x.bpm) {
      // A grid set in rekordbox counts as set by hand: analysis leaves it alone.
      patch.bpm = x.bpm;
      patch.anchor = x.anchor ?? t.anchor ?? 0;
      patch.analysisVersion = x.anchor !== undefined ? -1 : t.analysisVersion;
    }
    if (x.memoryCues.length && t.cue === undefined) patch.cue = x.memoryCues[0].time;
    updateTrack(t.id, patch);
  }
  let made = 0;
  for (const p of xml.playlists) {
    const ids = p.trackIds.map((i) => idMap.get(i)).filter((i): i is string => !!i);
    if (ids.length === 0) continue;
    const existing = playlists().find((x) => x.name === p.name);
    if (existing) await savePlaylist({ ...existing, trackIds: ids });
    else {
      const created = await createPlaylist(p.name);
      await savePlaylist({ ...created, trackIds: ids });
    }
    made++;
  }
  return {
    inXml: xml.tracks.length,
    matched: idMap.size,
    playlists: made,
    missing: missing.slice(0, 8),
    missingCount: missing.length,
  };
}

// --- Helpers ------------------------------------------------------------------------

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
}

async function parallel<T>(items: T[], n: number, f: (item: T) => Promise<void>) {
  let i = 0;
  const lanes = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++];
      try {
        await f(item);
      } catch (e) {
        console.warn(e);
      }
    }
  });
  await Promise.all(lanes);
}
