// What goes on a USB stick, in the shape both exporters take. Matches the Rust model in
// crates/bm-export/src/model.rs (the Pioneer exporter reads this as JSON).

/** Where the Engine DJ library goes on the stick. */
export const ENGINE_DB_PATH = "/Engine Library/Database2/m.db";

export interface ExportHotCue {
  /** 0 = A … 7 = H. */
  index: number;
  time: number;
  loopEnd?: number;
  /** `#rrggbb`. */
  color: string;
  name: string;
}

export interface ExportMemoryCue {
  time: number;
  loopEnd?: number;
  name: string;
}

export interface ExportTrack {
  /** From the stick's root: `/Contents/Artist/Album/file.mp3`. */
  filePath: string;
  title: string;
  artist: string;
  album: string;
  genre: string;
  comment: string;
  label: string;
  /** As Pioneer players should show it ("8A" or "Am"). */
  key: string;
  /** Engine DJ's key number (C major 0, A minor 1, G major 2… round the circle of fifths). */
  engineKey?: number;
  bpm: number;
  anchor: number;
  duration: number;
  sampleRate: number;
  bitDepth: number;
  bitrate: number;
  fileSize: number;
  fileType: string;
  year: number;
  rating: number;
  playCount: number;
  /** `YYYY-MM-DD`. */
  dateAdded: string;
  /** Seconds since 1970. */
  added: number;
  cue?: number;
  hotCues: ExportHotCue[];
  memoryCues: ExportMemoryCue[];
}

export interface ExportPlaylist {
  /** Folder path, outermost first. */
  folders: string[];
  name: string;
  /** Indices into the track list. */
  tracks: number[];
}

export interface ExportLibrary {
  tracks: ExportTrack[];
  playlists: ExportPlaylist[];
}
