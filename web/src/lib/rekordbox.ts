// Reads a rekordbox collection export (rekordbox: File → Export Collection in xml
// format). The format is documented by AlphaTheta as "rekordbox.xml": a COLLECTION
// of TRACKs (with TEMPO and POSITION_MARK children) and a PLAYLISTS tree of NODEs.

import { parseKey } from "./keys";
import type { Cue, MusicalKey } from "./types";

export interface XmlTrack {
  id: string;
  /** The file name, from the Location URL. */
  fileName: string;
  location: string;
  size: number;
  title: string;
  artist: string;
  album: string;
  genre: string;
  comment: string;
  rating: number;
  playCount: number;
  duration?: number;
  bpm?: number;
  /** A downbeat, in seconds. */
  anchor?: number;
  key?: MusicalKey;
  hotCues: (Cue | null)[];
  memoryCues: Cue[];
}

export interface XmlPlaylist {
  /** Folder path and name, e.g. "Sets / Friday". */
  name: string;
  trackIds: string[];
}

export interface XmlLibrary {
  tracks: XmlTrack[];
  playlists: XmlPlaylist[];
}

const num = (el: Element, attr: string): number | undefined => {
  const v = el.getAttribute(attr);
  if (v === null || v === "") return undefined;
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
};

function color(el: Element, fallback: string): string {
  const r = num(el, "Red");
  const g = num(el, "Green");
  const b = num(el, "Blue");
  if (r === undefined || g === undefined || b === undefined) return fallback;
  return `#${[r, g, b].map((x) => Math.max(0, Math.min(255, x)).toString(16).padStart(2, "0")).join("")}`;
}

export function parseRekordboxXml(text: string, palette: string[]): XmlLibrary {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror") || !doc.querySelector("DJ_PLAYLISTS")) {
    throw new Error("This is not a rekordbox collection (rekordbox.xml).");
  }
  const tracks: XmlTrack[] = [];
  for (const el of Array.from(doc.querySelectorAll("COLLECTION > TRACK"))) {
    const location = el.getAttribute("Location") ?? "";
    let path = location;
    try {
      path = decodeURIComponent(location.replace(/^file:\/\/localhost/, "").replace(/^file:\/\//, ""));
    } catch {
      /* keep it as it is */
    }
    const fileName = path.split(/[\\/]/).pop() ?? "";
    const t: XmlTrack = {
      id: el.getAttribute("TrackID") ?? "",
      fileName,
      location: path,
      size: num(el, "Size") ?? 0,
      title: el.getAttribute("Name") ?? "",
      artist: el.getAttribute("Artist") ?? "",
      album: el.getAttribute("Album") ?? "",
      genre: el.getAttribute("Genre") ?? "",
      comment: el.getAttribute("Comments") ?? "",
      rating: Math.round((num(el, "Rating") ?? 0) / 51),
      playCount: num(el, "PlayCount") ?? 0,
      duration: num(el, "TotalTime"),
      key: parseKey(el.getAttribute("Tonality") ?? undefined),
      hotCues: Array(8).fill(null),
      memoryCues: [],
    };
    // The first tempo marker sets the grid; Battito is its beat in the bar (1-4).
    const tempo = el.querySelector("TEMPO");
    if (tempo) {
      const bpm = num(tempo, "Bpm");
      const start = num(tempo, "Inizio");
      const beat = num(tempo, "Battito") ?? 1;
      if (bpm && bpm > 0 && start !== undefined) {
        t.bpm = bpm;
        t.anchor = start - ((beat - 1) * 60) / bpm;
      }
    }
    if (!t.bpm) {
      const avg = num(el, "AverageBpm");
      if (avg && avg > 0) t.bpm = avg;
    }
    for (const m of Array.from(el.querySelectorAll("POSITION_MARK"))) {
      const n = num(m, "Num") ?? -1;
      const time = num(m, "Start");
      if (time === undefined) continue;
      const end = num(m, "End");
      const cue: Cue = { time, color: color(m, n >= 0 ? palette[n % palette.length] : "#ff3d3d") };
      const name = m.getAttribute("Name");
      if (name) cue.name = name;
      if (num(m, "Type") === 4 && end !== undefined && end > time) cue.loopEnd = end;
      if (n >= 0 && n < 8) t.hotCues[n] = cue;
      else t.memoryCues.push(cue);
    }
    t.memoryCues.sort((a, b) => a.time - b.time);
    tracks.push(t);
  }

  const playlists: XmlPlaylist[] = [];
  const walk = (node: Element, path: string[]) => {
    for (const child of Array.from(node.children)) {
      if (child.tagName !== "NODE") continue;
      const name = child.getAttribute("Name") ?? "";
      if (child.getAttribute("Type") === "0") {
        walk(child, [...path, name]);
      } else {
        const ids = Array.from(child.querySelectorAll(":scope > TRACK"))
          .map((tr) => tr.getAttribute("Key") ?? "")
          .filter(Boolean);
        playlists.push({ name: [...path, name].join(" / "), trackIds: ids });
      }
    }
  };
  const root = doc.querySelector("PLAYLISTS > NODE");
  if (root) walk(root, []);
  return { tracks, playlists };
}
