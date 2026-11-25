//! Reads a Pioneer device export back with rekordcrate and prints what a player would
//! find: tracks, playlists, and each track's beat grid and cues.
//! `cargo run -p bm-export --example read_export -- <stick root>`.

use binrw::BinRead;
use bm_export::pioneer::analysis_path;
use rekordcrate::anlz::{Content, ANLZ};
use rekordcrate::device::PlaylistNode;
use rekordcrate::DeviceExport;

fn print_tree(nodes: &[PlaylistNode], export: &mut DeviceExport, depth: usize) {
    for n in nodes {
        match n {
            PlaylistNode::Folder(f) => {
                println!("{}[{}]", "  ".repeat(depth), f.name);
                print_tree(&f.children, export, depth + 1);
            }
            PlaylistNode::Playlist(p) => {
                let tracks = export.playlist_tracks(p.id).unwrap_or_default();
                println!(
                    "{}{} ({} tracks: {:?})",
                    "  ".repeat(depth),
                    p.name,
                    tracks.len(),
                    tracks
                );
            }
        }
    }
}

fn main() {
    let root =
        std::path::PathBuf::from(std::env::args().nth(1).expect("usage: read_export <root>"));
    let mut export = DeviceExport::open(&root).expect("open export.pdb");
    for (id, t) in export.tracks().expect("tracks") {
        println!(
            "track {id:?}: {} - {} [{}] key {:?} {:.2} BPM {}s {} Hz {} kbps {}",
            t.artist,
            t.title,
            t.album,
            t.key,
            t.tempo,
            t.duration_secs,
            t.sample_rate,
            t.bitrate,
            t.file_path
        );
        let dat = root.join(analysis_path(&t.file_path, "DAT").trim_start_matches('/'));
        let ext = root.join(analysis_path(&t.file_path, "EXT").trim_start_matches('/'));
        for file in [dat, ext] {
            let bytes = std::fs::read(&file).expect("analysis file at the computed path");
            let anlz = ANLZ::read(&mut std::io::Cursor::new(bytes)).expect("parse");
            for s in &anlz.sections {
                match &s.content {
                    Content::BeatGrid(g) => println!(
                        "   grid: {} beats, first {:?}, tempo {}",
                        g.beats.len(),
                        g.beats.first().map(|b| (b.beat_number, b.time)),
                        g.beats.first().map_or(0, |b| b.tempo)
                    ),
                    Content::ExtendedCueList(l) => {
                        for c in &l.cues {
                            println!(
                                "   {:?} cue {}: {:?} at {} ms (loop to {}) {:?} colour {:#x} {:?}",
                                l.list_type,
                                c.hot_cue,
                                c.cue_type,
                                c.time,
                                c.loop_time,
                                c.comment.0,
                                c.hot_cue_color_index,
                                c.hot_cue_color_rgb
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    let tree = export.playlists().expect("playlists");
    print_tree(&tree, &mut export, 0);
}
