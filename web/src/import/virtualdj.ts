// Reads VirtualDJ's library (Documents/VirtualDJ/database.xml) and its playlists (the XML
// files in Documents/VirtualDJ/My Lists, VirtualDJ 2024 and later). From VirtualDJ's
// wiki: Song (FilePath, FileSize) with Tags, Infos, Scan and Poi children; Scan Bpm is
// seconds per beat. Cue points are read as Poi Type="cue" (Num 1 = A) and the grid from
// Poi Type="beatgrid"; those two are not documented and not yet tried on real files.

import { parseKey } from "../lib/keys";
import { HOT_CUE_COLORS, type Cue } from "../lib/types";
import { baseName, type ImportedLibrary, type ImportedPlaylist, type ImportedTrack, noHotCues } from "./model";

const num = (el: Element | null | undefined, attr: string): number | undefined => {
  const v = el?.getAttribute(attr);
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const pathKey = (p: string) => p.replace(/\\/g, "/").normalize("NFC").toLowerCase();

export function parseVirtualDjDatabase(text: string): ImportedTrack[] {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror") || !doc.querySelector("VirtualDJ_Database")) {
    throw new Error("This is not a VirtualDJ database (database.xml).");
  }
  const tracks: ImportedTrack[] = [];
  for (const song of Array.from(doc.querySelectorAll("VirtualDJ_Database > Song"))) {
    const path = song.getAttribute("FilePath") ?? "";
    if (!path) continue;
    const tags = song.querySelector(":scope > Tags");
    const infos = song.querySelector(":scope > Infos");
    const scan = song.querySelector(":scope > Scan");
    const t: ImportedTrack & { hotCues: (Cue | null)[] } = {
      id: pathKey(path),
      fileName: baseName(path),
      location: path,
      size: num(song, "FileSize"),
      title: tags?.getAttribute("Title") ?? "",
      artist: tags?.getAttribute("Author") ?? "",
      album: tags?.getAttribute("Album") ?? "",
      genre: tags?.getAttribute("Genre") ?? "",
      comment: song.querySelector(":scope > Comment")?.textContent ?? "",
      rating: Math.max(0, Math.min(5, Math.round(num(tags, "Stars") ?? 0))),
      playCount: num(infos, "PlayCount") ?? 0,
      key: parseKey(scan?.getAttribute("Key") ?? tags?.getAttribute("Key") ?? undefined),
      hotCues: noHotCues(),
    };
    const spb = num(scan, "Bpm");
    if (spb && spb > 0) t.bpm = 60 / spb;
    for (const poi of Array.from(song.querySelectorAll(":scope > Poi"))) {
      const type = (poi.getAttribute("Type") ?? "").toLowerCase();
      const pos = num(poi, "Pos");
      if (pos === undefined || pos < 0) continue;
      if (type === "beatgrid") {
        if (t.bpm && t.anchor === undefined) t.anchor = pos;
      } else if (type === "cue") {
        const n = (num(poi, "Num") ?? 0) - 1;
        if (n < 0 || n > 7) continue;
        const cue: Cue = { time: pos, color: HOT_CUE_COLORS[n] };
        const name = poi.getAttribute("Name");
        if (name) cue.name = name;
        t.hotCues[n] = cue;
      }
    }
    tracks.push(t);
  }
  return tracks;
}

/** A "My Lists" playlist: <VirtualFolder> of <song path=…>. */
export function parseVirtualDjList(text: string): string[] {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror") || !doc.querySelector("VirtualFolder")) return [];
  return Array.from(doc.querySelectorAll("VirtualFolder > song"))
    .map((s) => s.getAttribute("path") ?? "")
    .filter(Boolean)
    .map(pathKey);
}

export function virtualDjLibrary(database: string, lists: { name: string; text: string }[]): ImportedLibrary {
  const tracks = parseVirtualDjDatabase(database);
  const known = new Set(tracks.map((t) => t.id));
  const playlists: ImportedPlaylist[] = [];
  for (const l of lists) {
    const ids = parseVirtualDjList(l.text);
    // Songs a list names that the database doesn't: still matchable by file name.
    for (const id of ids) {
      if (known.has(id)) continue;
      known.add(id);
      tracks.push({ id, fileName: baseName(id), location: id });
    }
    if (ids.length) playlists.push({ name: l.name.replace(/\.xml$/i, ""), trackIds: ids });
  }
  return { source: "VirtualDJ", tracks, playlists };
}
