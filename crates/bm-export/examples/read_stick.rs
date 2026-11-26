//! Prints what `bm_export::read` finds on a rekordbox USB stick:
//! `cargo run -p bm-export --example read_stick -- E:/`

use bm_export::read::{read_analysis, read_device};
use std::path::Path;

fn main() {
    let root = std::env::args().nth(1).expect("the stick's root folder");
    let root = Path::new(&root);
    let pdb = std::fs::read(root.join("PIONEER/rekordbox/export.pdb"))
        .expect("PIONEER/rekordbox/export.pdb");
    let ext = std::fs::read(root.join("PIONEER/rekordbox/exportExt.pdb")).ok();
    let stick = read_device(pdb, ext).expect("readable export.pdb");
    for t in &stick.tracks {
        println!(
            "{} | {} - {} | {} | {:.2} BPM | {} | {}★ | {}",
            t.id, t.artist, t.title, t.key, t.bpm, t.file_path, t.rating, t.analysis_path
        );
        let dat = std::fs::read(root.join(t.analysis_path.trim_start_matches('/')));
        let ext = std::fs::read(
            root.join(t.analysis_path.trim_start_matches('/'))
                .with_extension("EXT"),
        )
        .ok();
        if let Ok(dat) = dat {
            let a = read_analysis(&dat, ext.as_deref());
            println!("    grid: {:?} BPM from {:?} s", a.bpm, a.anchor);
            for c in &a.cues {
                println!(
                    "    cue {} at {:.3} s{} {:?} {:?}",
                    c.hot_cue,
                    c.time,
                    c.loop_end
                        .map(|e| format!(" to {e:.3}"))
                        .unwrap_or_default(),
                    c.color,
                    c.name
                );
            }
        }
    }
    for p in &stick.playlists {
        println!("playlist {:?}: {:?}", p.name, p.track_ids);
    }
}
