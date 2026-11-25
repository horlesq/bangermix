//! A Pioneer export, read back with rekordcrate's parsers (which read rekordbox's own
//! exports): analysis files section by section against rekordbox's layout, and the
//! database through `DeviceExport::open`, as a player-side reader would see it.

use binrw::BinRead;
use bm_export::model::{HotCue, Library, MemoryCue, Playlist, Track};
use bm_export::pioneer::{analysis_path, database, track_files};
use rekordcrate::anlz::{Content, ContentKind, CueListType, CueType, ANLZ};
use rekordcrate::pdb::io::Database;
use rekordcrate::pdb::DatabaseType;
use rekordcrate::{DeviceExport, PlaylistTreeNodeId};
use std::io::Cursor;

fn track(path: &str, title: &str) -> Track {
    Track {
        file_path: path.into(),
        title: title.into(),
        artist: "Test Artist".into(),
        album: "Test Album".into(),
        genre: "House".into(),
        key: "8A".into(),
        bpm: 128.0,
        anchor: 0.3,
        duration: 30.0,
        sample_rate: 44100,
        bit_depth: 16,
        bitrate: 320,
        file_size: 1_200_000,
        file_type: "mp3".into(),
        year: 2026,
        rating: 4,
        date_added: "2026-11-25".into(),
        cue: Some(0.3),
        hot_cues: vec![
            HotCue {
                index: 0,
                time: 0.3,
                loop_end: None,
                color: "#ff2d6f".into(),
                name: "Drop".into(),
            },
            HotCue {
                index: 2,
                time: 7.8,
                loop_end: Some(9.675),
                color: "#28e214".into(),
                name: String::new(),
            },
        ],
        memory_cues: vec![MemoryCue {
            time: 15.3,
            loop_end: None,
            name: "Break".into(),
        }],
        ..Default::default()
    }
}

/// A synthetic waveform: 100 columns a second, a kick-heavy bar pattern.
fn waveform(seconds: f64) -> Vec<u8> {
    let n = (seconds * 100.0) as usize;
    (0..n)
        .flat_map(|i| {
            let kick = (i % 47) < 6;
            [
                if kick { 240 } else { 120 },
                if kick { 200 } else { 40 },
                90,
                30,
            ]
        })
        .collect()
}

fn parse(bytes: &[u8]) -> ANLZ {
    ANLZ::read(&mut Cursor::new(bytes)).expect("rekordcrate reads the file")
}

fn kinds(a: &ANLZ) -> Vec<ContentKind> {
    a.sections.iter().map(|s| s.header.kind.clone()).collect()
}

#[test]
fn analysis_files_have_rekordbox_layout() {
    let t = track("/Contents/Test Artist/Test Album/Song.mp3", "Song");
    let files = track_files(&t, &waveform(t.duration), 100.0);
    assert_eq!(files.len(), 3);
    let folder = analysis_path(&t.file_path, "DAT");
    assert!(folder.starts_with("/PIONEER/USBANLZ/P"), "{folder}");

    let dat = parse(&files[0].1);
    assert_eq!(
        kinds(&dat),
        [
            ContentKind::Path,
            ContentKind::VBR,
            ContentKind::BeatGrid,
            ContentKind::WaveformPreview,
            ContentKind::TinyWaveformPreview,
            ContentKind::CueList,
            ContentKind::CueList
        ]
    );
    let ext = parse(&files[1].1);
    assert_eq!(
        kinds(&ext),
        [
            ContentKind::Path,
            ContentKind::WaveformDetail,
            ContentKind::CueList,
            ContentKind::CueList,
            ContentKind::ExtendedCueList,
            ContentKind::ExtendedCueList,
            ContentKind::WaveformColorDetail,
            ContentKind::WaveformColorPreview
        ]
    );
    let two = parse(&files[2].1);
    assert_eq!(
        kinds(&two),
        [
            ContentKind::Path,
            ContentKind::Waveform3BandDetail,
            ContentKind::Waveform3BandPreview,
            ContentKind::Waveform3BandCalibration
        ]
    );

    // Header and total sizes as in rekordbox's files (rekordcrate's demo export).
    let sizes: Vec<(u32, u32)> = dat
        .sections
        .iter()
        .map(|s| (s.header.size, s.header.total_size))
        .collect();
    assert_eq!(sizes[1], (16, 1620), "PVBR");
    assert_eq!(sizes[3], (20, 420), "PWAV");
    assert_eq!(sizes[4], (20, 120), "PWV2");
    let two_sizes: Vec<(u32, u32)> = two
        .sections
        .iter()
        .map(|s| (s.header.size, s.header.total_size))
        .collect();
    assert_eq!(two_sizes[2], (20, 3620), "PWV6");
    assert_eq!(two_sizes[3], (14, 20), "PWVC");

    for a in [&dat, &ext, &two] {
        match &a.sections[0].content {
            Content::Path(p) => assert_eq!(p.path.to_string(), t.file_path),
            other => panic!("expected a path, got {other:?}"),
        }
    }
}

#[test]
fn beat_grid_counts_bars_from_the_downbeat() {
    let t = track("/Contents/a.mp3", "a");
    let files = track_files(&t, &waveform(t.duration), 100.0);
    let dat = parse(&files[0].1);
    let Content::BeatGrid(grid) = &dat.sections[2].content else {
        panic!("no beat grid");
    };
    let beat: f64 = 60.0 / 128.0;
    // 0.3 s is a downbeat and the first beat; the grid runs to the end of the track.
    assert_eq!(grid.beats.len(), ((30.0 - 0.3) / beat).ceil() as usize);
    assert_eq!(grid.beats[0].beat_number, 1);
    assert_eq!(grid.beats[0].time, 300);
    assert_eq!(grid.beats[1].beat_number, 2);
    assert_eq!(grid.beats[4].beat_number, 1);
    assert_eq!(
        grid.beats[4].time,
        (300.0f64 + 4.0 * beat * 1000.0).round() as u32
    );
    assert!(grid.beats.iter().all(|b| b.tempo == 12800));

    // An anchor late in the track still gives beats from the start, numbered so the
    // anchor is beat 1.
    let late = Track { anchor: 10.0, ..t };
    let files = track_files(&late, &waveform(late.duration), 100.0);
    let Content::BeatGrid(grid) = &parse(&files[0].1).sections[2].content else {
        panic!("no beat grid");
    };
    let at_anchor = grid
        .beats
        .iter()
        .find(|b| b.time == 10_000)
        .expect("a beat on the anchor");
    assert_eq!(at_anchor.beat_number, 1);
    assert!(grid.beats[0].time < 500);
}

#[test]
fn cues_carry_loops_colours_and_names() {
    let t = track("/Contents/a.mp3", "a");
    let files = track_files(&t, &waveform(t.duration), 100.0);
    let ext = parse(&files[1].1);
    let lists: Vec<_> = ext
        .sections
        .iter()
        .filter_map(|s| match &s.content {
            Content::ExtendedCueList(l) => Some(l),
            _ => None,
        })
        .collect();
    let hot = lists
        .iter()
        .find(|l| l.list_type == CueListType::HotCues)
        .unwrap();
    assert_eq!(hot.cues.len(), 2);
    assert_eq!(hot.cues[0].hot_cue, 1);
    assert_eq!(hot.cues[0].time, 300);
    assert_eq!(hot.cues[0].comment.0, "Drop");
    assert_eq!(
        hot.cues[0].hot_cue_color_index, 0x2c,
        "#ff2d6f is palette code 2c"
    );
    assert_eq!(hot.cues[0].hot_cue_color_rgb, (0xff, 0x2d, 0x6f));
    assert_eq!(hot.cues[1].hot_cue, 3);
    assert_eq!(hot.cues[1].cue_type, CueType::Loop);
    assert_eq!(hot.cues[1].loop_time, 9675);

    let memory = lists
        .iter()
        .find(|l| l.list_type == CueListType::MemoryCues)
        .unwrap();
    // The main cue first, then the memory cue.
    assert_eq!(memory.cues.len(), 2);
    assert_eq!(memory.cues[0].time, 300);
    assert_eq!(memory.cues[1].time, 15300);
    assert_eq!(memory.cues[1].comment.0, "Break");

    // The original cue list in the .DAT has the same hot cues, for older players.
    let dat = parse(&files[0].1);
    let Content::CueList(old) = &dat.sections[5].content else {
        panic!("no cue list");
    };
    assert_eq!(old.list_type, CueListType::HotCues);
    assert_eq!(
        old.cues.iter().map(|c| c.hot_cue).collect::<Vec<_>>(),
        [1, 3]
    );
}

#[test]
fn waveforms_have_the_lengths_players_expect() {
    let t = track("/Contents/a.mp3", "a");
    let files = track_files(&t, &waveform(t.duration), 100.0);
    let dat = parse(&files[0].1);
    let ext = parse(&files[1].1);
    let two = parse(&files[2].1);
    let detail = (30.0f64 * 150.0).ceil() as usize;
    for s in dat
        .sections
        .iter()
        .chain(&ext.sections)
        .chain(&two.sections)
    {
        match &s.content {
            Content::WaveformPreview(w) => {
                assert_eq!(w.data.len(), 400);
                assert!(
                    w.data.iter().any(|c| c.height() > 10),
                    "the preview is not flat"
                );
            }
            Content::TinyWaveformPreview(w) => assert_eq!(w.data.len(), 100),
            Content::WaveformDetail(w) => assert_eq!(w.data.len(), detail),
            Content::WaveformColorDetail(w) => {
                assert_eq!(w.data.len(), detail);
                // A kick-heavy track is red (lows) at the kicks. Decoded as Deep
                // Symmetry documents it (red in the top bits of a big-endian u16),
                // which rekordbox's own files fit; rekordcrate's bitfield reads these
                // two bytes in the other bit order.
                let red = |c: &rekordcrate::anlz::WaveformColorDetailColumn| {
                    u16::from_be_bytes(c.into_bytes()) >> 13
                };
                assert!(w.data.iter().any(|c| red(c) == 7));
            }
            Content::WaveformColorPreview(w) => assert_eq!(w.data.len(), 1200),
            Content::Waveform3BandPreview(w) => assert_eq!(w.data.len(), 1200),
            Content::Waveform3BandDetail(w) => assert_eq!(w.data.len(), detail),
            _ => {}
        }
    }
}

#[test]
fn database_reads_back_with_tracks_and_playlists() {
    let a = track("/Contents/Test Artist/Test Album/One.mp3", "One");
    let b = Track {
        file_path: "/Contents/Other/Two.flac".into(),
        title: "Two".into(),
        artist: "Other".into(),
        file_type: "flac".into(),
        bpm: 0.0,
        ..track("", "")
    };
    let library = Library {
        tracks: vec![a.clone(), b.clone()],
        playlists: vec![
            Playlist {
                folders: vec!["Gigs".into()],
                name: "Friday".into(),
                tracks: vec![1, 0],
            },
            Playlist {
                folders: vec!["Gigs".into()],
                name: "Saturday".into(),
                tracks: vec![0],
            },
            Playlist {
                folders: vec![],
                name: "Warmup".into(),
                tracks: vec![0, 1],
            },
        ],
    };
    let files = database(&library).expect("export");
    let names: Vec<&str> = files.iter().map(|(p, _)| p.as_str()).collect();
    assert!(
        names.contains(&"/PIONEER/rekordbox/export.pdb"),
        "{names:?}"
    );
    assert!(names.contains(&"/PIONEER/DEVSETTING.DAT"), "{names:?}");
    assert_eq!(
        names.last(),
        Some(&"/PIONEER/rekordbox/export.pdb"),
        "the database goes last"
    );

    // Lay the files out on disk and open them as a reader would.
    let root = std::env::temp_dir().join(format!("bm-export-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    for (path, bytes) in &files {
        let p = root.join(path.trim_start_matches('/'));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, bytes).unwrap();
    }
    let mut export = DeviceExport::open(&root).expect("rekordcrate opens the export");
    let tracks = export.tracks().unwrap();
    assert_eq!(tracks.len(), 2);
    let (one_id, one) = tracks
        .iter()
        .find(|(_, t)| t.title == "One")
        .unwrap()
        .clone();
    let (two_id, _) = tracks
        .iter()
        .find(|(_, t)| t.title == "Two")
        .unwrap()
        .clone();
    assert_eq!(one.artist, "Test Artist");
    assert_eq!(one.album, "Test Album");
    assert_eq!(one.genre, "House");
    assert_eq!(one.key, "8A");
    assert_eq!(one.file_path, a.file_path);
    assert_eq!(one.filename, "One.mp3");
    assert!((one.tempo - 128.0).abs() < 0.01);
    assert_eq!(one.duration_secs, 30);
    assert_eq!(one.sample_rate, 44100);
    assert_eq!(one.bitrate, 320);

    let tree = export.playlists().unwrap();
    let text = format!("{tree:?}");
    for name in ["Gigs", "Friday", "Saturday", "Warmup"] {
        assert!(text.contains(name), "{name} missing from {text}");
    }
    // Find "Friday" and check its order.
    let friday = find_playlist(&tree, "Friday").expect("Friday");
    assert_eq!(export.playlist_tracks(friday).unwrap(), [two_id, one_id]);

    // Every track names the analysis file at the path players compute.
    let pdb = std::fs::File::open(root.join("PIONEER/rekordbox/export.pdb")).unwrap();
    let mut db = Database::open_non_persistent(pdb, DatabaseType::Plain).unwrap();
    use fallible_iterator::FallibleIterator;
    let paths: Vec<(String, String)> = db
        .iter_rows::<rekordcrate::pdb::Track>()
        .unwrap()
        .map(|t| {
            let s = &t.offsets.inner;
            Ok((
                s.file_path.clone().into_string()?,
                s.analyze_path.clone().into_string()?,
            ))
        })
        .collect()
        .unwrap();
    for (file, analysis) in paths {
        assert_eq!(analysis, analysis_path(&file, "DAT"));
    }
    let _ = std::fs::remove_dir_all(&root);
    let _ = PlaylistTreeNodeId::root();
}

fn find_playlist(
    nodes: &[rekordcrate::device::PlaylistNode],
    name: &str,
) -> Option<PlaylistTreeNodeId> {
    use rekordcrate::device::PlaylistNode;
    for n in nodes {
        match n {
            PlaylistNode::Playlist(p) if p.name == name => return Some(p.id),
            PlaylistNode::Folder(f) => {
                if let Some(id) = find_playlist(&f.children, name) {
                    return Some(id);
                }
            }
            _ => {}
        }
    }
    None
}
