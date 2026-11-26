/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  crateName,
  looseBase64,
  parseBeatGrid,
  parseMarkers2,
  parseSeratoCrate,
  parseSeratoDatabase,
  readSeratoTags,
  seratoCueColor,
} from "../serato";
import { ascii, b64, cat, f32, u32, utf16be } from "./bytes";

// --- Builders, following the documented layouts ---------------------------------------

const field = (tag: string, data: Uint8Array) => cat(ascii(tag), u32(data.length), data);
const z = (...b: number[]) => new Uint8Array(b);

function markers2(): Uint8Array {
  const entry = (type: string, data: Uint8Array) => cat(ascii(type), z(0), u32(data.length), data);
  const cue = (index: number, ms: number, rgb: number[], name: string) =>
    entry("CUE", cat(z(0, index), u32(ms), z(0, ...rgb, 0, 0), ascii(name), z(0)));
  const loop = (index: number, start: number, end: number, rgb: number[], name: string) =>
    entry("LOOP", cat(z(0, index), u32(start), u32(end), z(255, 255, 255, 255, 0, ...rgb, 0, 0), ascii(name), z(0)));
  const inner = cat(
    z(1, 1),
    entry("COLOR", z(0, 0xff, 0xff, 0xff)),
    cue(0, 1000, [0xcc, 0, 0], "Intro"),
    cue(3, 64_500, [0x00, 0xcc, 0x00], ""),
    loop(0, 32_000, 40_000, [0x27, 0xaa, 0xe1], "Build"),
    entry("BPMLOCK", z(0)),
    z(0),
  );
  // Serato wraps its base64 every 72 characters and drops the padding.
  const text = b64(inner).replace(/=+$/, "").replace(/(.{72})/g, "$1\n");
  return cat(z(1, 1), ascii(text), new Uint8Array(20));
}

const beatgrid = (markers: [number, number][], bpm: number) => {
  const lastPos = markers.length ? markers[markers.length - 1][0] + 30 : 0.25;
  return cat(z(1, 0), u32(markers.length + 1), ...markers.map(([pos, beats]) => cat(f32(pos), u32(beats))), f32(lastPos), f32(bpm), z(0));
};

const syncsafe = (n: number) => z((n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127);
const id3 = (...frames: Uint8Array[]) => {
  const body = cat(...frames);
  return cat(ascii("ID3"), z(4, 0, 0), syncsafe(body.length), body);
};
const geob = (desc: string, data: Uint8Array) => {
  const body = cat(z(0), ascii("application/octet-stream"), z(0, 0), ascii(desc), z(0), data);
  return cat(ascii("GEOB"), syncsafe(body.length), z(0, 0), body);
};
// An MPEG-1 layer III frame header at 44.1 kHz, then silence.
const mp3Frames = cat(z(0xff, 0xfb, 0x90, 0x00), new Uint8Array(400));

// --- Tests -------------------------------------------------------------------------------

describe("Serato database and crates", () => {
  it("reads tracks", () => {
    const track = field(
      "otrk",
      cat(
        field("ttyp", utf16be("mp3")),
        field("pfil", utf16be("Users/me/Music/House/Track One.mp3")),
        field("tsng", utf16be("Track One")),
        field("tart", utf16be("Someone")),
        field("tbpm", utf16be("124.00")),
        field("tkey", utf16be("Am")),
        field("uadd", u32(1_700_000_000)),
      ),
    );
    const db = cat(field("vrsn", utf16be("2.0/Serato Scratch LIVE Database")), track);
    const [t] = parseSeratoDatabase(db);
    expect(t.fileName).toBe("Track One.mp3");
    expect(t.title).toBe("Track One");
    expect(t.artist).toBe("Someone");
    expect(t.bpm).toBe(124);
    expect(t.key).toEqual({ tonic: 9, minor: true });
    expect(t.id).toBe("users/me/music/house/track one.mp3");
  });

  it("rejects other files", () => {
    expect(() => parseSeratoDatabase(ascii("hello"))).toThrow(/not a Serato/);
  });

  it("reads crates and their names", () => {
    const crate = cat(field("vrsn", utf16be("1.0/Serato ScratchLive Crate")), field("otrk", field("ptrk", utf16be("Users/me/Music/House/Track One.mp3"))));
    expect(parseSeratoCrate(crate)).toEqual(["users/me/music/house/track one.mp3"]);
    expect(crateName("Gigs%%Friday.crate")).toBe("Gigs / Friday");
  });
});

describe("Serato Markers2", () => {
  it("reads hot cues, names, colours and saved loops", () => {
    const m = parseMarkers2(markers2());
    expect(m.hotCues[0]).toEqual({ time: 1, color: "#c02626", name: "Intro" });
    expect(m.hotCues[3]).toMatchObject({ time: 64.5, color: "#1fad26" });
    expect(m.hotCues[1]).toBeNull();
    expect(m.loops).toEqual([{ time: 32, loopEnd: 40, color: "#27aae1", name: "Build" }]);
  });

  it("maps stored colours to the ones Serato shows", () => {
    expect(seratoCueColor(0xcc, 0x88, 0x00)).toBe("#f8821a");
    expect(seratoCueColor(0x12, 0x34, 0x56)).toBe("#123456");
  });

  it("decodes base64 without padding and with line breaks", () => {
    expect([...looseBase64("AQID\nBA")]).toEqual([1, 2, 3, 4]);
  });
});

describe("Serato BeatGrid", () => {
  it("reads a constant grid", () => {
    expect(parseBeatGrid(beatgrid([], 128))).toMatchObject({ bpm: 128, anchor: 0.25 });
  });
  it("takes the longest part of a grid with tempo changes", () => {
    const g = parseBeatGrid(
      beatgrid(
        [
          [0.1, 16],
          [7.6, 64],
        ],
        120,
      ),
    )!;
    // 64 beats over the 30 s from 7.6 s is the longest part.
    expect(g.anchor).toBeCloseTo(7.6, 3);
    expect(g.bpm).toBeCloseTo(128, 3);
  });
});

describe("Serato tags in audio files", () => {
  it("reads an MP3's GEOB frames and allows for the MP3 decoder delay", async () => {
    const file = new File([id3(geob("Serato Markers2", markers2()), geob("Serato BeatGrid", beatgrid([], 128))), mp3Frames], "a.mp3");
    const t = await readSeratoTags(file);
    expect(t.bpm).toBe(128);
    expect(t.anchor).toBeCloseTo(0.25 - 0.026, 4);
    expect(t.hotCues![0]!.time).toBeCloseTo(1 - 0.026, 4);
    expect(t.memoryCues![0].loopEnd).toBeCloseTo(40 - 0.026, 4);
  });

  it("reads a FLAC's Vorbis comments", async () => {
    const prefix = (name: string) => ascii(`application/octet-stream\0\0Serato ${name}\0`);
    const comment = (k: string, v: string) => {
      const s = ascii(`${k}=${v}`);
      return cat(u32(s.length, true), s);
    };
    const vorbis = cat(
      u32(6, true),
      ascii("vendor"),
      u32(2, true),
      comment("SERATO_MARKERS_V2", b64(cat(prefix("Markers2"), markers2()))),
      comment("SERATO_BEATGRID", b64(cat(prefix("BeatGrid"), beatgrid([], 126)))),
    );
    const block = (type: number, last: boolean, data: Uint8Array) =>
      cat(z((last ? 0x80 : 0) | type, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255), data);
    const file = new File([ascii("fLaC"), block(0, false, new Uint8Array(34)), block(4, true, vorbis)], "a.flac");
    const t = await readSeratoTags(file);
    expect(t.bpm).toBe(126);
    expect(t.anchor).toBeCloseTo(0.25, 4);
    expect(t.hotCues![0]).toMatchObject({ time: 1, name: "Intro" });
  });

  it("reads an MP4's com.serato.dj atoms", async () => {
    const atom = (type: string, ...body: Uint8Array[]) => {
      const b = cat(...body);
      return cat(u32(8 + b.length), ascii(type), b);
    };
    const prefix = ascii("application/octet-stream\0\0Serato BeatGrid\0");
    const freeform = atom(
      "----",
      atom("mean", new Uint8Array(4), ascii("com.serato.dj")),
      atom("name", new Uint8Array(4), ascii("beatgrid")),
      atom("data", u32(1), new Uint8Array(4), ascii(b64(cat(prefix, beatgrid([], 122))))),
    );
    const moov = atom("moov", atom("udta", atom("meta", new Uint8Array(4), atom("hdlr", new Uint8Array(25)), atom("ilst", freeform))));
    const file = new File([atom("ftyp", ascii("M4A "), new Uint8Array(4)), moov, atom("mdat", new Uint8Array(16))], "a.m4a");
    expect((await readSeratoTags(file)).bpm).toBe(122);
  });

  it("finds nothing in a file without Serato tags", async () => {
    expect(await readSeratoTags(new File([mp3Frames], "plain.mp3"))).toEqual({});
  });
});

// Real tag contents written by Serato DJ, from Mixxx's test data (src/test/serato/data).
// Set MIXXX_SERATO_DATA to that folder to check them; they aren't part of this repository.
const real = process.env.MIXXX_SERATO_DATA;
describe.skipIf(!real)("Serato tags written by Serato DJ (Mixxx's test data)", () => {
  const read = (dir: string) => readdirSync(join(real!, dir)).map((f) => ({ f, b: new Uint8Array(readFileSync(join(real!, dir, f))) }));
  it("parses every MP3 Markers2 sample", () => {
    for (const { f, b } of read("mp3/markers2")) expect(parseMarkers2(b).hotCues.length, f).toBe(8);
    const named = parseMarkers2(new Uint8Array(readFileSync(join(real!, "mp3/markers2/hotcues-with-names.octet-stream"))));
    expect(named.hotCues.some((c) => c?.name)).toBe(true);
  });
  it("parses every MP3 BeatGrid sample", () => {
    for (const { f, b } of read("mp3/beatgrid")) expect(parseBeatGrid(b), f).toBeDefined();
  });
  it("reads the FLAC samples as Vorbis comments of a FLAC file", async () => {
    const flac = (key: string, value: Uint8Array) => {
      const s = cat(ascii(`${key}=`), value);
      const vorbis = cat(u32(0, true), u32(1, true), u32(s.length, true), s);
      const n = vorbis.length;
      return new File([ascii("fLaC"), z(0x84, (n >> 16) & 255, (n >> 8) & 255, n & 255), vorbis], "a.flac");
    };
    const cues = await readSeratoTags(flac("SERATO_MARKERS_V2", read("flac/markers2").find((x) => x.f.startsWith("hocues"))!.b));
    expect(cues.hotCues?.some(Boolean)).toBe(true);
    const grid = await readSeratoTags(flac("SERATO_BEATGRID", read("flac/beatgrid")[0].b));
    expect(grid.bpm).toBeGreaterThan(0);
  });
});
