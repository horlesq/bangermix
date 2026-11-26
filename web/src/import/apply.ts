// Applies another app's library to this one: each imported track is matched to a file
// already in the library, and its grid, key, cues, rating and play count come across.
// The other app's playlists are added under a folder named after it.

import type { TrackRec } from "../lib/types";
import { createPlaylist, fileFor, playlists, savePlaylist, trackById, tracks, updateTrack } from "../state/library";
import type { ImportedLibrary, ImportedTrack, ImportProgress, ImportReport } from "./model";

const norm = (s: string) => s.normalize("NFC").toLowerCase();
const segments = (path: string) => norm(path).split(/[\\/]+/).filter(Boolean);

/** How many path segments, from the end, two paths share. */
function sharedTail(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function matcher() {
  const byNameSize = new Map<string, TrackRec>();
  const byName = new Map<string, TrackRec[]>();
  for (const t of tracks()) {
    const name = norm(t.name);
    byNameSize.set(`${name}|${t.size}`, t);
    byName.set(name, [...(byName.get(name) ?? []), t]);
  }
  return (x: ImportedTrack): TrackRec | undefined => {
    if (x.libraryId) return trackById(x.libraryId);
    const name = norm(x.fileName);
    if (x.size) {
      const t = byNameSize.get(`${name}|${x.size}`);
      if (t) return t;
    }
    const same = byName.get(name) ?? [];
    if (same.length <= 1) return same[0];
    // Several files of that name (copies, or different tracks): the one whose folders
    // match the source's path best, else the first.
    const path = segments(x.location);
    let best = same[0];
    let score = 0;
    for (const t of same) {
      const s = sharedTail(path, segments(t.path));
      if (s > score) {
        score = s;
        best = t;
      }
    }
    return best;
  };
}

function patchFor(t: TrackRec, x: ImportedTrack): Partial<TrackRec> {
  const patch: Partial<TrackRec> = {};
  if (x.rating) patch.rating = x.rating;
  if (x.playCount && x.playCount > t.playCount) patch.playCount = x.playCount;
  if (x.hotCues?.some(Boolean)) patch.hotCues = x.hotCues;
  if (x.memoryCues?.length) patch.memoryCues = x.memoryCues;
  if (x.comment && !t.comment) patch.comment = x.comment;
  if (x.genre && !t.genre) patch.genre = x.genre;
  if (x.key) patch.key = x.key;
  if (x.bpm && x.bpm > 0) {
    patch.bpm = x.bpm;
    if (x.anchor !== undefined) {
      // A grid set in another app counts as set by hand: analysis leaves it alone.
      patch.anchor = x.anchor;
      patch.analysisVersion = -1;
    } else {
      patch.anchor = t.anchor ?? 0;
    }
  }
  if (x.cue !== undefined) patch.cue = x.cue;
  else if (t.cue === undefined && x.memoryCues?.length) patch.cue = x.memoryCues[0].time;
  return patch;
}

const hasCues = (x: ImportedTrack) =>
  (x.bpm !== undefined && x.anchor !== undefined) || !!x.hotCues?.some(Boolean) || !!x.memoryCues?.length;

export async function applyImport(lib: ImportedLibrary, onProgress?: (p: ImportProgress) => void): Promise<ImportReport> {
  const find = matcher();
  const idMap = new Map<string, string>();
  const missing: string[] = [];
  let withCues = 0;

  for (let i = 0; i < lib.tracks.length; i++) {
    let x = lib.tracks[i];
    if (i % 25 === 0) onProgress?.({ phase: "Matching tracks", done: i, total: lib.tracks.length });
    const t = find(x);
    if (!t) {
      missing.push(x.fileName || x.location);
      continue;
    }
    idMap.set(x.id, t.id);
    if (lib.fromFile) {
      try {
        x = { ...x, ...(await lib.fromFile(x, await fileFor(t))) };
      } catch {
        /* the file's tags are a bonus: the track still matches */
      }
    }
    if (hasCues(x)) withCues++;
    updateTrack(t.id, patchFor(t, x));
  }

  let made = 0;
  for (const p of lib.playlists) {
    const ids = [...new Set(p.trackIds.map((i) => idMap.get(i)).filter((i): i is string => !!i))];
    if (ids.length === 0) continue;
    const name = `${lib.source} / ${p.name}`;
    const existing = playlists().find((x) => x.name === name);
    if (existing) await savePlaylist({ ...existing, trackIds: ids });
    else await savePlaylist({ ...(await createPlaylist(name)), trackIds: ids });
    made++;
  }
  onProgress?.({ phase: "Done", done: lib.tracks.length, total: lib.tracks.length });
  return {
    source: lib.source,
    inSource: lib.tracks.length,
    matched: idMap.size,
    playlists: made,
    withCues,
    missing: missing.slice(0, 8),
    missingCount: missing.length,
  };
}
