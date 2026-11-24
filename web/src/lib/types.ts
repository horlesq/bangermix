// The library's data model.

export interface Cue {
  /** Seconds into the track. */
  time: number;
  color: string;
  name?: string;
  /** A saved loop ends here. */
  loopEnd?: number;
}

export interface MusicalKey {
  tonic: number;
  minor: boolean;
  confidence?: number;
}

export interface TrackRec {
  /** `${folderId}/${path}` for files in a folder, `drop:${name}:${size}` for dropped files. */
  id: string;
  folderId: string;
  path: string;
  name: string;
  ext: string;
  size: number;
  mtime: number;
  title: string;
  artist: string;
  album: string;
  genre: string;
  comment: string;
  year: string;
  tagBpm?: number;
  tagKey?: string;
  duration?: number;
  /** From analysis (or edited by hand). */
  bpm?: number;
  /** A downbeat, in seconds. */
  anchor?: number;
  gridConfidence?: number;
  key?: MusicalKey;
  loudness?: number;
  analysisVersion?: number;
  analysisError?: string;
  /** Main cue point. */
  cue?: number;
  hotCues: (Cue | null)[];
  memoryCues: Cue[];
  rating: number;
  playCount: number;
  lastPlayed?: number;
  dateAdded: number;
  hasArt?: boolean;
}

export interface FolderRec {
  id: string;
  name: string;
  /** Absent for files dropped in without a folder handle. */
  handle?: FileSystemDirectoryHandle;
  addedAt: number;
}

export interface PlaylistRec {
  id: string;
  name: string;
  trackIds: string[];
  createdAt: number;
}

/** Bumped when the analysis changes enough that tracks should be analysed again. */
export const ANALYSIS_VERSION = 1;

export const AUDIO_EXTENSIONS = ["mp3", "flac", "wav", "wave", "aif", "aiff", "m4a", "aac", "mp4", "ogg", "oga"];

export const HOT_CUE_COLORS = ["#ff4fa3", "#ffb020", "#3ddc84", "#3db8ff", "#b18cff", "#ff6b3d", "#f4f46a", "#5af0d0"];
