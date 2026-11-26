//! Reading a stick back: what bangermix's own export writes, `read` must recover.

use bm_export::model::{HotCue, Library, MemoryCue, Playlist, Track};
use bm_export::pioneer::{database, track_files};
use bm_export::read::{read_analysis, read_device};

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
        rating: 4,
        play_count: 7,
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

#[test]
fn reads_back_what_the_export_writes() {
    let library = Library {
        tracks: vec![
            track("/Contents/A/B/one.mp3", "One"),
            track("/Contents/A/B/two.mp3", "Two"),
        ],
        playlists: vec![Playlist {
            folders: vec!["Gigs".into()],
            name: "Friday".into(),
            tracks: vec![1, 0],
        }],
    };
    let files = database(&library).unwrap();
    let pdb = files
        .iter()
        .find(|(p, _)| p.ends_with("export.pdb"))
        .unwrap()
        .1
        .clone();
    let stick = read_device(pdb, None).unwrap();

    assert_eq!(stick.tracks.len(), 2);
    let one = stick.tracks.iter().find(|t| t.title == "One").unwrap();
    assert_eq!(one.file_path, "/Contents/A/B/one.mp3");
    assert_eq!(one.artist, "Test Artist");
    assert_eq!(one.key, "8A");
    assert_eq!(one.rating, 4);
    assert_eq!(one.play_count, 7);
    assert!((one.bpm - 128.0).abs() < 0.01);
    assert!(
        one.analysis_path.starts_with("/PIONEER/USBANLZ/")
            && one.analysis_path.ends_with("ANLZ0000.DAT")
    );

    assert_eq!(stick.playlists.len(), 1);
    assert_eq!(stick.playlists[0].name, "Gigs / Friday");
    let two = stick.tracks.iter().find(|t| t.title == "Two").unwrap();
    assert_eq!(stick.playlists[0].track_ids, vec![two.id, one.id]);

    // The analysis files that export wrote for track one.
    let analysis = track_files(&library.tracks[0], &[], 150.0);
    let file = |ext: &str| {
        analysis
            .iter()
            .find(|(p, _)| p.ends_with(ext))
            .map(|(_, b)| b.as_slice())
    };
    assert_eq!(
        one.analysis_path,
        analysis.iter().find(|(p, _)| p.ends_with("DAT")).unwrap().0
    );
    let a = read_analysis(file("DAT").unwrap(), file("EXT"));
    assert!((a.bpm.unwrap() - 128.0).abs() < 0.01);
    assert!((a.anchor.unwrap() - 0.3).abs() < 0.002);

    let hot: Vec<_> = a.cues.iter().filter(|c| c.hot_cue > 0).collect();
    assert_eq!(hot.len(), 2);
    assert_eq!(hot[0].hot_cue, 1);
    assert_eq!(hot[0].name, "Drop");
    assert!(hot[0].color.is_some());
    assert_eq!(hot[1].hot_cue, 3);
    assert!((hot[1].loop_end.unwrap() - 9.675).abs() < 0.002);
    let memory: Vec<_> = a
        .cues
        .iter()
        .filter(|c| c.hot_cue == 0)
        .map(|c| (c.time, c.name.as_str()))
        .collect();
    // The main cue goes on the stick as the first memory cue.
    assert!(memory
        .iter()
        .any(|&(t, n)| (t - 15.3).abs() < 0.002 && n == "Break"));
    assert!(memory.iter().any(|&(t, _)| (t - 0.3).abs() < 0.002));
}

#[test]
fn unreadable_analysis_gives_nothing_rather_than_failing() {
    let a = read_analysis(b"not an anlz file", None);
    assert!(a.bpm.is_none() && a.cues.is_empty());
}
