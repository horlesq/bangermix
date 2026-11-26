import { describe, expect, it } from "vitest";
import { HOT_CUE_COLORS } from "../../lib/types";
import { parseRekordboxXml } from "../rekordbox";
import { parseTraktorNml, traktorKey } from "../traktor";
import { parseVirtualDjList, virtualDjLibrary } from "../virtualdj";

describe("Traktor collection.nml", () => {
  const nml = `<?xml version="1.0" encoding="UTF-8" standalone="no" ?>
<NML VERSION="19"><HEAD COMPANY="www.native-instruments.com" PROGRAM="Traktor"></HEAD>
<COLLECTION ENTRIES="2">
<ENTRY TITLE="Track One" ARTIST="Someone">
  <LOCATION DIR="/:Users/:me/:Music/:House/:" FILE="Track One.mp3" VOLUME="C:" VOLUMEID="abc"></LOCATION>
  <ALBUM TITLE="An Album"></ALBUM>
  <INFO BITRATE="320000" GENRE="House" COMMENT="nice" PLAYCOUNT="3" RANKING="204" PLAYTIME="300" FILESIZE="7000"></INFO>
  <TEMPO BPM="124.000061" BPM_QUALITY="100.000000"></TEMPO>
  <MUSICAL_KEY VALUE="21"></MUSICAL_KEY>
  <CUE_V2 NAME="AutoGrid" DISPL_ORDER="0" TYPE="4" START="120.5" LEN="0.000000" REPEATS="-1" HOTCUE="0"></CUE_V2>
  <CUE_V2 NAME="Drop" DISPL_ORDER="0" TYPE="0" START="64120.5" LEN="0.000000" REPEATS="-1" HOTCUE="1"></CUE_V2>
  <CUE_V2 NAME="n.n." DISPL_ORDER="0" TYPE="5" START="32000" LEN="7741.9" REPEATS="-1" HOTCUE="2"></CUE_V2>
  <CUE_V2 NAME="Outro" DISPL_ORDER="0" TYPE="2" START="280000" LEN="0" REPEATS="-1" HOTCUE="-1"></CUE_V2>
</ENTRY>
<ENTRY TITLE="Track Two" ARTIST="Other">
  <LOCATION DIR="/:Users/:me/:Music/:" FILE="Track Two.flac" VOLUME="C:"></LOCATION>
  <MUSICAL_KEY VALUE="0"></MUSICAL_KEY>
</ENTRY>
</COLLECTION>
<PLAYLISTS><NODE TYPE="FOLDER" NAME="$ROOT"><SUBNODES COUNT="3">
  <NODE TYPE="PLAYLIST" NAME="_LOOPS"><PLAYLIST ENTRIES="0" TYPE="LIST"></PLAYLIST></NODE>
  <NODE TYPE="FOLDER" NAME="Gigs"><SUBNODES COUNT="1">
    <NODE TYPE="PLAYLIST" NAME="Friday"><PLAYLIST ENTRIES="2" TYPE="LIST" UUID="x">
      <ENTRY><PRIMARYKEY TYPE="TRACK" KEY="C:/:Users/:me/:Music/:Track Two.flac"></PRIMARYKEY></ENTRY>
      <ENTRY><PRIMARYKEY TYPE="TRACK" KEY="C:/:Users/:me/:Music/:House/:Track One.mp3"></PRIMARYKEY></ENTRY>
    </PLAYLIST></NODE>
  </SUBNODES></NODE>
</SUBNODES></NODE></PLAYLISTS>
</NML>`;

  it("reads tracks, grid, key, cues and loops", () => {
    const lib = parseTraktorNml(nml);
    expect(lib.tracks).toHaveLength(2);
    const t = lib.tracks[0];
    expect(t.fileName).toBe("Track One.mp3");
    expect(t.location).toBe("C:/Users/me/Music/House/Track One.mp3");
    expect(t).toMatchObject({ title: "Track One", artist: "Someone", album: "An Album", genre: "House", rating: 4, playCount: 3 });
    expect(t.key).toEqual({ tonic: 9, minor: true });
    expect(t.bpm).toBeCloseTo(124, 3);
    expect(t.anchor).toBeCloseTo(0.1205, 6);
    expect(t.hotCues![0]).toBeNull();
    expect(t.hotCues![1]).toMatchObject({ time: 64.1205, name: "Drop" });
    expect(t.hotCues![2]!.loopEnd).toBeCloseTo(39.7419, 4);
    expect(t.hotCues![2]!.name).toBeUndefined();
    expect(t.memoryCues).toHaveLength(1);
    expect(lib.tracks[1].key).toEqual({ tonic: 0, minor: false });
  });

  it("reads playlists in folders, leaving out Traktor's own lists", () => {
    const lib = parseTraktorNml(nml);
    expect(lib.playlists.map((p) => p.name)).toEqual(["Gigs / Friday"]);
    expect(lib.playlists[0].trackIds).toEqual([lib.tracks[1].id, lib.tracks[0].id]);
  });

  it("maps Traktor key numbers", () => {
    expect(traktorKey(7)).toEqual({ tonic: 7, minor: false });
    expect(traktorKey(24)).toBeUndefined();
  });

  it("rejects other files", () => {
    expect(() => parseTraktorNml("<x/>")).toThrow(/not a Traktor/);
  });
});

describe("rekordbox.xml", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DJ_PLAYLISTS Version="1.0.0"><PRODUCT Name="rekordbox" Version="7.0.0" Company="AlphaTheta"/>
<COLLECTION Entries="1">
  <TRACK TrackID="7" Name="Track One" Artist="Someone" Genre="House" Size="7340032" TotalTime="300" AverageBpm="124.00" Tonality="8A" Rating="204" PlayCount="2" Location="file://localhost/C:/Music/House/Track%20One.mp3">
    <TEMPO Inizio="0.494" Bpm="124.00" Metro="4/4" Battito="2"/>
    <POSITION_MARK Name="Drop" Type="0" Start="64.120" Num="1" Red="40" Green="226" Blue="20"/>
    <POSITION_MARK Name="" Type="4" Start="32.000" End="39.742" Num="2"/>
    <POSITION_MARK Name="Mem" Type="0" Start="10.000" Num="-1"/>
  </TRACK>
</COLLECTION>
<PLAYLISTS><NODE Type="0" Name="ROOT" Count="1">
  <NODE Name="Sets" Type="0" Count="1"><NODE Name="Friday" Type="1" KeyType="0" Entries="1"><TRACK Key="7"/></NODE></NODE>
</NODE></PLAYLISTS>
</DJ_PLAYLISTS>`;

  it("reads tracks, grid, cues and playlists", () => {
    const lib = parseRekordboxXml(xml, HOT_CUE_COLORS);
    const t = lib.tracks[0];
    expect(t).toMatchObject({ fileName: "Track One.mp3", size: 7340032, rating: 4, playCount: 2 });
    // Battito 2: the marker is beat 2, so the downbeat is one beat earlier.
    expect(t.anchor).toBeCloseTo(0.494 - 60 / 124, 6);
    expect(t.hotCues![1]).toMatchObject({ time: 64.12, name: "Drop", color: "#28e214" });
    expect(t.hotCues![2]).toMatchObject({ time: 32, loopEnd: 39.742 });
    expect(t.memoryCues).toHaveLength(1);
    expect(lib.playlists).toEqual([{ name: "Sets / Friday", trackIds: ["7"] }]);
  });
});

describe("VirtualDJ database.xml", () => {
  const db = `<?xml version="1.0" encoding="UTF-8"?>
<VirtualDJ_Database Version="8.1">
 <Song FilePath="D:\\Music\\House\\Track One.mp3" FileSize="7340032" Flag="0">
  <Tags Author="Someone" Title="Track One" Genre="House" Album="An Album" Stars="4" Key="Am" />
  <Infos SongLength="300.5" PlayCount="5" />
  <Comment>nice</Comment>
  <Scan Version="801" Bpm="0.483871" AltBpm="0.967742" Volume="1" Key="8A" Flag="32768" />
  <Poi Pos="0.12" Type="beatgrid" />
  <Poi Name="Drop" Pos="64.12" Num="1" Type="cue" />
  <Poi Pos="200" Num="9" Type="cue" />
 </Song>
</VirtualDJ_Database>`;
  const list = `<?xml version="1.0" encoding="UTF-8"?>
<VirtualFolder noDuplicates="no" ordered="yes">
 <song path="D:\\Music\\House\\Track One.mp3" size="7340032" idx="0" />
 <song path="D:\\Music\\Other.mp3" size="100" idx="1" />
</VirtualFolder>`;

  it("reads tracks, BPM (stored as seconds per beat), key and cues", () => {
    const lib = virtualDjLibrary(db, []);
    const t = lib.tracks[0];
    expect(t).toMatchObject({ fileName: "Track One.mp3", size: 7340032, title: "Track One", rating: 4, playCount: 5, comment: "nice" });
    expect(t.bpm).toBeCloseTo(124, 2);
    expect(t.anchor).toBe(0.12);
    expect(t.key).toEqual({ tonic: 9, minor: true });
    expect(t.hotCues![0]).toMatchObject({ time: 64.12, name: "Drop" });
    expect(t.hotCues!.filter(Boolean)).toHaveLength(1);
  });

  it("reads My Lists playlists, including songs only the list names", () => {
    expect(parseVirtualDjList(list)).toHaveLength(2);
    const lib = virtualDjLibrary(db, [{ name: "Warm up.xml", text: list }]);
    expect(lib.playlists).toEqual([{ name: "Warm up", trackIds: [lib.tracks[0].id, "d:/music/other.mp3"] }]);
    expect(lib.tracks[1].fileName).toBe("other.mp3");
  });
});
