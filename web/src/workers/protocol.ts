// Messages between the app and the decoder workers.

export interface JobRequest {
  /** decode: stereo audio for a deck (optionally analysed too); analyse: analysis
   * only, from a mono decode; probe: tags only; pioneerTrack / pioneerDb: Pioneer USB
   * export files, from `bytes` = u32 JSON length, JSON, then a waveform (crates/bm-export). */
  op: "decode" | "analyse" | "probe" | "pioneerTrack" | "pioneerDb";
  bytes: ArrayBuffer;
  ext: string;
  analyse?: boolean;
  bpmRange: [number, number];
  columnsPerS: number;
}

export interface AnalysisResult {
  duration: number;
  bpm: number;
  anchor: number;
  gridConfidence: number;
  downbeatConfidence: number;
  key: { tonic: number; minor: boolean; confidence: number } | null;
  loudness: number;
  columnsPerS: number;
}

export interface TagsResult {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  comment?: string;
  year?: string;
  bpm?: number;
  key?: string;
  duration?: number;
  sampleRate?: number;
  bitDepth?: number;
  artType?: string;
  art: Uint8Array | null;
}

export interface JobResult {
  rate?: number;
  left?: Float32Array;
  right?: Float32Array;
  analysis?: AnalysisResult;
  waveform?: Uint8Array;
  tags?: TagsResult;
  /** Export files: path from the device root, and contents. */
  files?: { path: string; data: Uint8Array }[];
}
