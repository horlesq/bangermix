// What every importer produces: another app's tracks (with grids and cues) and
// playlists, before they are matched to the files in this library.

import type { Cue, MusicalKey } from "../lib/types";

export type ImportSource = "rekordbox" | "rekordbox USB" | "Serato" | "Traktor" | "Engine DJ" | "Mixxx" | "VirtualDJ";

export interface ImportedTrack {
  /** The source's own id, which its playlists refer to. */
  id: string;
  /** The file's name, for matching to the library. */
  fileName: string;
  /** Its full path in the source (shown when it can't be found; breaks ties between
   * files with the same name). */
  location: string;
  /** Bytes, when the source knows (helps matching). */
  size?: number;
  /** The library track this is, when the importer already knows (a stick it added). */
  libraryId?: string;
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  comment?: string;
  /** 0–5. */
  rating?: number;
  playCount?: number;
  bpm?: number;
  /** A downbeat, in seconds. With `bpm`, a grid set in the other app. */
  anchor?: number;
  key?: MusicalKey;
  /** The main cue, in seconds. */
  cue?: number;
  /** A–H; `null` where unset. */
  hotCues?: (Cue | null)[];
  memoryCues?: Cue[];
}

export interface ImportedPlaylist {
  /** Folders and name, "Sets / Friday". */
  name: string;
  trackIds: string[];
}

export interface ImportedLibrary {
  source: ImportSource;
  tracks: ImportedTrack[];
  playlists: ImportedPlaylist[];
  /** Details only the audio file holds (Serato keeps cues and grids in the file's tags),
   * read once a track is matched. */
  fromFile?: (t: ImportedTrack, file: File) => Promise<Partial<ImportedTrack>>;
}

export interface ImportReport {
  source: ImportSource;
  inSource: number;
  matched: number;
  playlists: number;
  /** Tracks whose grid or cues came across. */
  withCues: number;
  /** File names of tracks not found in the library (first few). */
  missing: string[];
  missingCount: number;
}

export interface ImportProgress {
  phase: string;
  done: number;
  total: number;
}

/** The part of a path after the last slash or backslash. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Eight empty hot cue slots. */
export const noHotCues = (): (Cue | null)[] => Array(8).fill(null);

/** `#rrggbb` from 0–255 components. */
export function hexColor(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("")}`;
}
