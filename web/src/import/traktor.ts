// Reads Traktor's collection (Documents/Native Instruments/Traktor <version>/collection.nml):
// ENTRY elements with LOCATION, INFO, TEMPO, MUSICAL_KEY and CUE_V2 children, and a
// PLAYLISTS tree of NODEs whose entries name tracks by volume + path.

import type { Cue } from "../lib/types";
import { type ImportedLibrary, type ImportedPlaylist, type ImportedTrack, noHotCues } from "./model";

const num = (el: Element | null | undefined, attr: string): number | undefined => {
  const v = el?.getAttribute(attr);
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Traktor's key numbers: 0–11 C major … B major, 12–23 C minor … B minor. */
export function traktorKey(value: number | undefined) {
  if (value === undefined || value < 0 || value > 23) return undefined;
  return { tonic: value % 12, minor: value >= 12 };
}

// Traktor has no cue colours; these follow its cue types.
const COLORS = { cue: "#2fa4ff", loop: "#3ddc84", fade: "#ffb020", load: "#ffd84a" };

/** The key Traktor's playlists use for a track: volume, then the path with "/:" as the
 * separator ("C:/:Users/:me/:Music/:track.mp3"). */
const primaryKey = (volume: string, dir: string, file: string) => `${volume}${dir}${file}`;

export function parseTraktorNml(text: string): ImportedLibrary {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror") || !doc.querySelector("NML")) {
    throw new Error("This is not a Traktor collection (collection.nml).");
  }
  const tracks: ImportedTrack[] = [];
  for (const entry of Array.from(doc.querySelectorAll("COLLECTION > ENTRY"))) {
    const loc = entry.querySelector(":scope > LOCATION");
    if (!loc) continue;
    const volume = loc.getAttribute("VOLUME") ?? "";
    const dir = loc.getAttribute("DIR") ?? "";
    const file = loc.getAttribute("FILE") ?? "";
    if (!file) continue;
    const info = entry.querySelector(":scope > INFO");
    const t: ImportedTrack & { hotCues: (Cue | null)[]; memoryCues: Cue[] } = {
      id: primaryKey(volume, dir, file),
      fileName: file,
      location: `${volume}${dir.replace(/\/:/g, "/")}${file}`,
      title: entry.getAttribute("TITLE") ?? "",
      artist: entry.getAttribute("ARTIST") ?? "",
      album: entry.querySelector(":scope > ALBUM")?.getAttribute("TITLE") ?? "",
      genre: info?.getAttribute("GENRE") ?? "",
      comment: info?.getAttribute("COMMENT") ?? "",
      // RANKING is 0–255, 51 a star.
      rating: Math.round((num(info, "RANKING") ?? 0) / 51),
      playCount: num(info, "PLAYCOUNT") ?? 0,
      key: traktorKey(num(entry.querySelector(":scope > MUSICAL_KEY"), "VALUE")),
      hotCues: noHotCues(),
      memoryCues: [],
    };
    const bpm = num(entry.querySelector(":scope > TEMPO"), "BPM");
    if (bpm && bpm > 0) t.bpm = bpm;

    for (const c of Array.from(entry.querySelectorAll(":scope > CUE_V2"))) {
      const type = num(c, "TYPE") ?? 0;
      const start = num(c, "START");
      if (start === undefined) continue;
      const time = start / 1000;
      // 4: the grid marker, on a downbeat.
      if (type === 4) {
        if (t.anchor === undefined) t.anchor = time;
        continue;
      }
      const len = num(c, "LEN") ?? 0;
      const cue: Cue = {
        time,
        color: type === 5 ? COLORS.loop : type === 1 || type === 2 ? COLORS.fade : type === 3 ? COLORS.load : COLORS.cue,
      };
      const name = c.getAttribute("NAME");
      if (name && name !== "n.n.") cue.name = name;
      if (type === 5 && len > 0) cue.loopEnd = time + len / 1000;
      const hot = num(c, "HOTCUE") ?? -1;
      if (hot >= 0 && hot < 8) t.hotCues[hot] = cue;
      else t.memoryCues.push(cue);
    }
    if (t.anchor !== undefined && !t.bpm) t.anchor = undefined;
    t.memoryCues.sort((a, b) => a.time - b.time);
    tracks.push(t);
  }

  const playlists: ImportedPlaylist[] = [];
  const walk = (node: Element, path: string[]) => {
    for (const child of Array.from(node.querySelectorAll(":scope > SUBNODES > NODE"))) {
      const name = child.getAttribute("NAME") ?? "";
      const type = child.getAttribute("TYPE");
      if (type === "FOLDER") walk(child, [...path, name]);
      else if (type === "PLAYLIST" && !name.startsWith("_")) {
        // _LOOPS, _RECORDINGS: Traktor's own lists, not the DJ's.
        const ids = Array.from(child.querySelectorAll(":scope > PLAYLIST > ENTRY > PRIMARYKEY"))
          .filter((k) => k.getAttribute("TYPE") === "TRACK")
          .map((k) => k.getAttribute("KEY") ?? "")
          .filter(Boolean);
        playlists.push({ name: [...path, name].join(" / "), trackIds: ids });
      }
    }
  };
  const root = doc.querySelector("PLAYLISTS > NODE");
  if (root) walk(root, []);
  return { source: "Traktor", tracks, playlists };
}
