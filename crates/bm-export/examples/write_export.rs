//! Writes a small Pioneer export (two tracks, a playlist) to a folder, for inspecting with
//! other tools: `cargo run -p bm-export --example write_export -- <folder>`.

use bm_export::model::{HotCue, Library, Playlist, Track};
use bm_export::pioneer::{database, track_files};

fn main() {
    let root = std::path::PathBuf::from(
        std::env::args()
            .nth(1)
            .expect("usage: write_export <folder>"),
    );
    let mk = |path: &str, title: &str, bpm: f64| Track {
        file_path: path.into(),
        title: title.into(),
        artist: "bangermix".into(),
        album: "Examples".into(),
        key: "8A".into(),
        bpm,
        anchor: 0.12,
        duration: 64.0,
        sample_rate: 44100,
        bit_depth: 16,
        bitrate: 320,
        file_size: 2_560_000,
        file_type: "mp3".into(),
        date_added: "2026-11-25".into(),
        cue: Some(0.12),
        hot_cues: vec![HotCue {
            index: 0,
            time: 0.12,
            color: "#e62828".into(),
            name: "Start".into(),
            ..Default::default()
        }],
        ..Default::default()
    };
    let library = Library {
        tracks: vec![
            mk("/Contents/bangermix/Examples/One.mp3", "One", 128.0),
            mk("/Contents/bangermix/Examples/Two.mp3", "Two", 174.0),
        ],
        playlists: vec![Playlist {
            folders: vec!["bangermix".into()],
            name: "Example".into(),
            tracks: vec![0, 1],
        }],
    };
    let waveform: Vec<u8> = (0..6400)
        .flat_map(|i| {
            let k = i % 47 < 6;
            [if k { 230 } else { 110 }, if k { 190 } else { 40 }, 80, 30]
        })
        .collect();
    let mut files = database(&library).expect("database");
    for t in &library.tracks {
        files.extend(track_files(t, &waveform, 100.0));
    }
    for (path, bytes) in files {
        let p = root.join(path.trim_start_matches('/'));
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, bytes).unwrap();
        println!("{}", p.display());
    }
}
