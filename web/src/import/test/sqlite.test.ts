// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ExportTrack } from "../../export/model";
import { fromEngineKey, readEngineDatabase } from "../engine";
import { mixxxKey, readMixxxBeats, readMixxxDatabase } from "../mixxx";
import { testSqlite } from "./sql";

vi.mock("../../lib/sqlite", async () => ({ sqlite: (await import("./sql")).testSqlite }));

const track = (over: Partial<ExportTrack> = {}): ExportTrack => ({
  filePath: "/Contents/Someone/An Album/Track One.mp3",
  title: "Track One",
  artist: "Someone",
  album: "An Album",
  genre: "House",
  comment: "",
  label: "",
  key: "8A",
  engineKey: 1,
  bpm: 124,
  anchor: 0.25,
  duration: 180,
  sampleRate: 44100,
  bitDepth: 0,
  bitrate: 320,
  fileSize: 7_340_032,
  fileType: "mp3",
  year: 2026,
  rating: 4,
  playCount: 2,
  dateAdded: "2026-11-26",
  added: 1_790_000_000,
  cue: 0.25,
  hotCues: [
    { index: 0, time: 10, color: "#ff2d6f", name: "Drop" },
    { index: 2, time: 30, loopEnd: 38, color: "#28e214", name: "Build" },
  ],
  memoryCues: [],
  ...over,
});

describe("Engine DJ library", () => {
  it("reads back what bangermix's Engine export writes", async () => {
    const { engineDatabase } = await import("../../export/engine");
    const db = await engineDatabase({
      library: {
        tracks: [track(), track({ filePath: "/Contents/Other/B/Two.flac", title: "Two", hotCues: [], cue: undefined, engineKey: 0 })],
        playlists: [{ folders: ["Gigs"], name: "Friday", tracks: [1, 0] }],
      },
      waveform: async () => undefined,
      columnsPerS: 100,
    });
    const lib = await readEngineDatabase(db, await testSqlite());
    expect(lib.tracks).toHaveLength(2);
    const t = lib.tracks.find((x) => x.title === "Track One")!;
    expect(t.location).toBe("../Contents/Someone/An Album/Track One.mp3");
    expect(t.fileName).toBe("Track One.mp3");
    expect(t.size).toBe(7_340_032);
    expect(t.rating).toBe(4);
    expect(t.key).toEqual({ tonic: 9, minor: true });
    expect(t.bpm).toBeCloseTo(124, 3);
    expect(t.anchor).toBeCloseTo(0.25, 3);
    expect(t.cue).toBeCloseTo(0.25, 4);
    expect(t.hotCues![0]).toMatchObject({ name: "Drop", color: "#ff2d6f" });
    expect(t.hotCues![0]!.time).toBeCloseTo(10, 4);
    // The looped hot cue comes back as one: Engine keeps its loop in a separate list.
    expect(t.hotCues![2]).toMatchObject({ name: "Build" });
    expect(t.hotCues![2]!.time).toBeCloseTo(30, 4);
    expect(t.hotCues![2]!.loopEnd).toBeCloseTo(38, 4);
    expect(t.memoryCues).toBeUndefined();
    expect(lib.tracks.find((x) => x.title === "Two")!.key).toEqual({ tonic: 0, minor: false });

    const two = lib.tracks.find((x) => x.title === "Two")!;
    expect(lib.playlists).toEqual([{ name: "Gigs / Friday", trackIds: [two.id, t.id] }]);
  });

  it("reads Engine DJ 2/3 libraries, whose performance data is in the Track table", async () => {
    const { engineDatabase } = await import("../../export/engine");
    const SQL = await testSqlite();
    const modern = new SQL.Database(await engineDatabase({ library: { tracks: [track()], playlists: [] }, waveform: async () => undefined, columnsPerS: 100 }));
    const perf = modern.exec("SELECT trackData, beatData, quickCues, loops FROM PerformanceData")[0].values[0];
    modern.close();
    const old = new SQL.Database();
    old.run(`CREATE TABLE Track (id INTEGER PRIMARY KEY, path TEXT, filename TEXT, fileBytes INTEGER, title TEXT, artist TEXT,
      album TEXT, genre TEXT, comment TEXT, rating INTEGER, bpm INTEGER, bpmAnalyzed REAL, key INTEGER,
      trackData BLOB, beatData BLOB, quickCues BLOB, loops BLOB);
      CREATE TABLE Playlist (id INTEGER PRIMARY KEY, title TEXT, parentListId INTEGER, nextListId INTEGER);
      CREATE TABLE PlaylistEntity (id INTEGER PRIMARY KEY, listId INTEGER, trackId INTEGER, nextEntityId INTEGER);`);
    old.run("INSERT INTO Track VALUES (1, 'Music/a.mp3', 'a.mp3', 10, 'A', '', '', '', '', 60, 124, 124.0, 1, ?, ?, ?, ?)", perf as never);
    const lib = await readEngineDatabase(old.export(), SQL);
    expect(lib.tracks[0].bpm).toBeCloseTo(124, 3);
    expect(lib.tracks[0].hotCues![0]!.time).toBeCloseTo(10, 4);
    expect(lib.tracks[0].rating).toBe(3);
  });

  it("maps Engine key numbers round the circle of fifths", () => {
    expect(fromEngineKey(0)).toEqual({ tonic: 0, minor: false }); // C
    expect(fromEngineKey(1)).toEqual({ tonic: 9, minor: true }); // Am
    expect(fromEngineKey(2)).toEqual({ tonic: 7, minor: false }); // G
    expect(fromEngineKey(3)).toEqual({ tonic: 4, minor: true }); // Em
    expect(fromEngineKey(23)).toEqual({ tonic: 2, minor: true }); // Dm
  });

  it("rejects other files", async () => {
    await expect(readEngineDatabase(new Uint8Array([1, 2, 3]), await testSqlite())).rejects.toThrow(/not an Engine DJ/);
  });
});

/** A protobuf message from (field, value) pairs: numbers as varints, floats as doubles,
 * bytes as length-delimited. */
function pb(...fields: [number, number | Uint8Array | { double: number }][]): Uint8Array {
  const out: number[] = [];
  const varint = (n: number) => {
    do {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n) b |= 128;
      out.push(b);
    } while (n);
  };
  for (const [f, v] of fields) {
    if (v instanceof Uint8Array) {
      varint(f * 8 + 2);
      varint(v.length);
      out.push(...v);
    } else if (typeof v === "object") {
      varint(f * 8 + 1);
      const b = new Uint8Array(8);
      new DataView(b.buffer).setFloat64(0, v.double, true);
      out.push(...b);
    } else {
      varint(f * 8);
      varint(v);
    }
  }
  return new Uint8Array(out);
}

describe("Mixxx library", () => {
  it("reads a BeatGrid-2.0 and a BeatMap-1.0 grid", () => {
    const grid = pb([1, pb([1, { double: 126 }])], [2, pb([1, 11025])]);
    expect(readMixxxBeats(grid, "BeatGrid-2.0", 44100)).toEqual({ bpm: 126, anchor: 0.25 });
    const beat = 44100 * (60 / 120);
    const map = pb(...[0, 1, 2, 3].map((i): [number, Uint8Array] => [1, pb([1, 4410 + i * beat])]));
    const m = readMixxxBeats(map, "BeatMap-1.0", 44100)!;
    expect(m.bpm).toBeCloseTo(120, 6);
    expect(m.anchor).toBeCloseTo(0.1, 6);
  });

  it("reads tracks, cues, playlists and crates", async () => {
    const SQL = await testSqlite();
    const db = new SQL.Database();
    db.run(`CREATE TABLE track_locations (id INTEGER PRIMARY KEY, location TEXT, filename TEXT, directory TEXT, filesize INTEGER, fs_deleted INTEGER);
      CREATE TABLE library (id INTEGER PRIMARY KEY, artist TEXT, title TEXT, album TEXT, genre TEXT, comment TEXT, rating INTEGER,
        timesplayed INTEGER, bpm REAL, key TEXT, key_id INTEGER, samplerate INTEGER, beats BLOB, beats_version TEXT,
        location INTEGER, mixxx_deleted INTEGER);
      CREATE TABLE cues (id INTEGER PRIMARY KEY, track_id INTEGER, type INTEGER, position INTEGER, length INTEGER, hotcue INTEGER, label TEXT, color INTEGER);
      CREATE TABLE Playlists (id INTEGER PRIMARY KEY, name TEXT, position INTEGER, hidden INTEGER);
      CREATE TABLE PlaylistTracks (id INTEGER PRIMARY KEY, playlist_id INTEGER, track_id INTEGER, position INTEGER);
      CREATE TABLE crates (id INTEGER PRIMARY KEY, name TEXT);
      CREATE TABLE crate_tracks (crate_id INTEGER, track_id INTEGER);`);
    db.run("INSERT INTO track_locations VALUES (1, 'C:/Music/a.mp3', 'a.mp3', 'C:/Music', 1234, 0), (2, 'C:/Music/gone.mp3', 'gone.mp3', 'C:/Music', 1, 1)");
    db.run("INSERT INTO library VALUES (1, 'Someone', 'A', '', 'House', '', 5, 9, 126, 'Am', 22, 44100, ?, 'BeatGrid-2.0', 1, 0)", [
      pb([1, pb([1, { double: 126 }])], [2, pb([1, 22050])]),
    ]);
    db.run("INSERT INTO library VALUES (2, '', 'Gone', '', '', '', 0, 0, 0, '', NULL, 44100, NULL, NULL, 2, 0)");
    // Positions in interleaved stereo samples: 88200 = one second.
    db.run(`INSERT INTO cues (track_id, type, position, length, hotcue, label, color) VALUES
      (1, 2, 44100, 0, -1, '', 0), (1, 1, 882000, 0, 0, 'Drop', 16711680), (1, 4, 1764000, 352800, 1, 'Loop', 65280)`);
    db.run("INSERT INTO Playlists VALUES (1, 'Warm up', 1, 0), (2, 'Auto DJ', 0, 1)");
    db.run("INSERT INTO PlaylistTracks VALUES (1, 1, 1, 1), (2, 2, 1, 1)");
    db.run("INSERT INTO crates VALUES (1, 'Techno'); INSERT INTO crate_tracks VALUES (1, 1)");

    const lib = readMixxxDatabase(db.export(), SQL);
    expect(lib.tracks).toHaveLength(1);
    const t = lib.tracks[0];
    expect(t).toMatchObject({ fileName: "a.mp3", size: 1234, rating: 5, playCount: 9, bpm: 126, anchor: 0.5, cue: 0.5 });
    expect(t.key).toEqual({ tonic: 9, minor: true });
    expect(t.hotCues![0]).toEqual({ time: 10, color: "#ff0000", name: "Drop" });
    expect(t.hotCues![1]).toEqual({ time: 20, loopEnd: 24, color: "#00ff00", name: "Loop" });
    expect(lib.playlists).toEqual([
      { name: "Warm up", trackIds: ["1"] },
      { name: "Crates / Techno", trackIds: ["1"] },
    ]);
  });

  it("maps Mixxx key ids", () => {
    expect(mixxxKey(1)).toEqual({ tonic: 0, minor: false });
    expect(mixxxKey(22)).toEqual({ tonic: 9, minor: true });
    expect(mixxxKey(0)).toBeUndefined();
  });
});
