// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaylistRec, TrackRec } from "../../lib/types";
import type { ImportedLibrary } from "../model";

// A library of three files, two with the same name in different folders.
const lib = vi.hoisted(() => {
  const state = { tracks: [] as TrackRec[], playlists: [] as PlaylistRec[], updates: new Map<string, Partial<TrackRec>>() };
  return state;
});

vi.mock("../../state/library", () => ({
  tracks: () => lib.tracks,
  trackById: (id: string) => lib.tracks.find((t) => t.id === id),
  updateTrack: (id: string, patch: Partial<TrackRec>) => lib.updates.set(id, { ...lib.updates.get(id), ...patch }),
  fileFor: async (t: TrackRec) => new File([], t.name),
  playlists: () => lib.playlists,
  createPlaylist: async (name: string) => {
    const p = { id: `p${lib.playlists.length}`, name, trackIds: [], createdAt: 0 };
    lib.playlists.push(p);
    return p;
  },
  savePlaylist: async (p: PlaylistRec) => {
    lib.playlists = lib.playlists.map((x) => (x.id === p.id ? p : x));
  },
}));

const { applyImport } = await import("../apply");

const rec = (id: string, path: string, size: number, over: Partial<TrackRec> = {}): TrackRec => ({
  id,
  folderId: "f1",
  path,
  name: path.split("/").pop()!,
  ext: "mp3",
  size,
  mtime: 0,
  title: "",
  artist: "",
  album: "",
  genre: "",
  comment: "",
  year: "",
  hotCues: Array(8).fill(null),
  memoryCues: [],
  rating: 0,
  playCount: 1,
  dateAdded: 0,
  ...over,
});

beforeEach(() => {
  lib.tracks = [
    rec("f1/House/intro.mp3", "House/intro.mp3", 100),
    rec("f1/Techno/intro.mp3", "Techno/intro.mp3", 200),
    rec("f1/Other/track.mp3", "Other/track.mp3", 300, { comment: "mine", bpm: 120, anchor: 0.5 }),
  ];
  lib.playlists = [];
  lib.updates.clear();
});

describe("applyImport", () => {
  it("matches by name and size, then by folders, and brings grids, cues and playlists", async () => {
    const imported: ImportedLibrary = {
      source: "Traktor",
      tracks: [
        // Same name twice: the size decides.
        { id: "a", fileName: "intro.mp3", location: "C:/x/intro.mp3", size: 200, bpm: 128, anchor: 0.1, rating: 5 },
        // No size: the folder decides.
        { id: "b", fileName: "INTRO.mp3", location: "D:/Music/House/intro.mp3", playCount: 9 },
        { id: "c", fileName: "track.mp3", location: "/track.mp3", comment: "theirs", genre: "Techno", hotCues: [{ time: 3, color: "#fff" }, null, null, null, null, null, null, null] },
        { id: "d", fileName: "missing.mp3", location: "/missing.mp3" },
      ],
      playlists: [
        { name: "Gigs / Friday", trackIds: ["c", "a", "d", "a"] },
        { name: "Empty", trackIds: ["d"] },
      ],
    };
    const r = await applyImport(imported);
    expect(r).toMatchObject({ source: "Traktor", inSource: 4, matched: 3, playlists: 1, withCues: 2, missingCount: 1, missing: ["missing.mp3"] });

    expect(lib.updates.get("f1/Techno/intro.mp3")).toMatchObject({ bpm: 128, anchor: 0.1, analysisVersion: -1, rating: 5 });
    expect(lib.updates.get("f1/House/intro.mp3")).toMatchObject({ playCount: 9 });
    const other = lib.updates.get("f1/Other/track.mp3")!;
    // A comment of the library's own stays; an empty genre is filled.
    expect(other.comment).toBeUndefined();
    expect(other.genre).toBe("Techno");
    expect(other.hotCues![0]).toEqual({ time: 3, color: "#fff" });

    expect(lib.playlists).toEqual([
      { id: "p0", name: "Traktor / Gigs / Friday", trackIds: ["f1/Other/track.mp3", "f1/Techno/intro.mp3"], createdAt: 0 },
    ]);
  });

  it("updates its playlists when imported again", async () => {
    const imported = (ids: string[]): ImportedLibrary => ({
      source: "Serato",
      tracks: [{ id: "x", fileName: "track.mp3", location: "track.mp3" }],
      playlists: [{ name: "Crate", trackIds: ids }],
    });
    await applyImport(imported(["x"]));
    await applyImport(imported(["x", "x"]));
    expect(lib.playlists).toHaveLength(1);
    expect(lib.playlists[0].trackIds).toEqual(["f1/Other/track.mp3"]);
  });

  it("reads what only the file holds for matched tracks", async () => {
    const fromFile = vi.fn(async () => ({ bpm: 125, anchor: 0.2 }));
    const r = await applyImport({
      source: "Serato",
      tracks: [
        { id: "x", fileName: "track.mp3", location: "track.mp3" },
        { id: "y", fileName: "nowhere.mp3", location: "nowhere.mp3" },
      ],
      playlists: [],
      fromFile,
    });
    expect(fromFile).toHaveBeenCalledTimes(1);
    expect(r.withCues).toBe(1);
    expect(lib.updates.get("f1/Other/track.mp3")).toMatchObject({ bpm: 125, anchor: 0.2, analysisVersion: -1 });
  });

  it("uses the library id an importer already knows", async () => {
    await applyImport({
      source: "rekordbox USB",
      tracks: [{ id: "1", fileName: "intro.mp3", location: "/Contents/intro.mp3", libraryId: "f1/House/intro.mp3", rating: 3 }],
      playlists: [],
    });
    expect(lib.updates.get("f1/House/intro.mp3")).toMatchObject({ rating: 3 });
  });
});
