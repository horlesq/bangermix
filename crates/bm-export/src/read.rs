//! Reading a rekordbox USB stick (one prepared in rekordbox, or by bangermix): its tracks
//! and playlists from `export.pdb`, and each track's beat grid and cues from its analysis
//! files. For importing a stick into the library.

use binrw::BinRead;
use rekordcrate::anlz::{Content, CueType, ANLZ};
use rekordcrate::device::PlaylistNode;
use rekordcrate::util::ColorIndex;
use rekordcrate::DeviceExport;
use serde::Serialize;
use std::io::Cursor;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickTrack {
    pub id: u32,
    /// From the stick's root: `/Contents/Artist/Album/file.mp3`.
    pub file_path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    pub comment: String,
    pub label: String,
    /// As rekordbox shows it ("Am", "8A").
    pub key: String,
    pub bpm: f32,
    pub duration: u16,
    pub file_size: u32,
    pub sample_rate: u32,
    /// 0–5 stars.
    pub rating: u8,
    pub play_count: u16,
    pub year: u16,
    pub date_added: String,
    /// `/PIONEER/USBANLZ/…/ANLZ0000.DAT`; the `.EXT` file sits beside it.
    pub analysis_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickPlaylist {
    /// Folders and name, joined with " / ".
    pub name: String,
    pub track_ids: Vec<u32>,
}

#[derive(Debug, Serialize)]
pub struct StickLibrary {
    pub tracks: Vec<StickTrack>,
    pub playlists: Vec<StickPlaylist>,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// The tracks and playlists of a stick, from `export.pdb` (and `exportExt.pdb`).
pub fn read_device(pdb: Vec<u8>, ext_pdb: Option<Vec<u8>>) -> Result<StickLibrary, String> {
    let mut export = DeviceExport::open_from_memory(pdb, ext_pdb).map_err(err)?;
    let paths = export.analysis_paths().map_err(err)?;
    let tracks = export
        .tracks()
        .map_err(err)?
        .into_iter()
        .map(|(id, t)| StickTrack {
            id: id.0,
            file_path: t.file_path,
            title: t.title,
            artist: t.artist,
            album: t.album,
            genre: t.genre,
            comment: t.comment,
            label: t.label,
            key: t.key,
            bpm: t.tempo,
            duration: t.duration_secs,
            file_size: t.file_size,
            sample_rate: t.sample_rate,
            rating: u8::from(t.rating).min(5),
            play_count: t.play_count,
            year: t.year,
            date_added: t.date_added,
            analysis_path: paths.get(&id).cloned().unwrap_or_default(),
        })
        .collect();

    let mut playlists = Vec::new();
    let mut stack: Vec<(Vec<String>, Vec<PlaylistNode>)> =
        vec![(Vec::new(), export.playlists().map_err(err)?)];
    while let Some((path, nodes)) = stack.pop() {
        for node in nodes {
            match node {
                PlaylistNode::Folder(f) => {
                    let mut p = path.clone();
                    p.push(f.name);
                    stack.push((p, f.children));
                }
                PlaylistNode::Playlist(p) => {
                    let ids = export.playlist_tracks(p.id).map_err(err)?;
                    let mut name = path.clone();
                    name.push(p.name);
                    playlists.push(StickPlaylist {
                        name: name.join(" / "),
                        track_ids: ids.into_iter().map(|i| i.0).collect(),
                    });
                }
            }
        }
    }
    Ok(StickLibrary { tracks, playlists })
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickCue {
    /// 1–8 for hot cues A–H, 0 for a memory cue.
    pub hot_cue: u32,
    /// Seconds.
    pub time: f64,
    pub loop_end: Option<f64>,
    /// `#rrggbb`, when the stick has one.
    pub color: Option<String>,
    pub name: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickAnalysis {
    pub bpm: Option<f64>,
    /// A downbeat, in seconds.
    pub anchor: Option<f64>,
    pub cues: Vec<StickCue>,
}

fn hex(r: u8, g: u8, b: u8) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// Memory cue colours as rekordbox shows them.
fn memory_color(c: &ColorIndex) -> Option<String> {
    Some(
        match c {
            ColorIndex::None => return None,
            ColorIndex::Pink => "#f870f8",
            ColorIndex::Red => "#f82c3c",
            ColorIndex::Orange => "#f8a030",
            ColorIndex::Yellow => "#f8e331",
            ColorIndex::Green => "#1fe021",
            ColorIndex::Aqua => "#00e0ff",
            ColorIndex::Blue => "#305aff",
            ColorIndex::Purple => "#9b6dff",
        }
        .to_string(),
    )
}

fn sections(bytes: &[u8]) -> Vec<Content> {
    // Files with sections this reader doesn't know still give the ones it does: read
    // the whole file first, and fall back to nothing rather than failing the import.
    ANLZ::read(&mut Cursor::new(bytes))
        .map(|a| a.sections.into_iter().map(|s| s.content).collect())
        .unwrap_or_default()
}

/// A track's grid and cues, from its `ANLZ0000.DAT` and (when there is one) `.EXT`, whose
/// cue list has colours and names.
pub fn read_analysis(dat: &[u8], ext: Option<&[u8]>) -> StickAnalysis {
    let mut out = StickAnalysis::default();
    let mut basic = Vec::new();
    for content in sections(dat) {
        match content {
            Content::BeatGrid(grid) => {
                if let Some(first) = grid.beats.iter().find(|b| b.beat_number == 1) {
                    out.anchor = Some(f64::from(first.time) / 1000.0);
                }
                if let Some(b) = grid.beats.first() {
                    out.bpm = Some(f64::from(b.tempo) / 100.0);
                }
            }
            Content::CueList(list) => {
                for c in list.cues {
                    basic.push(StickCue {
                        hot_cue: c.hot_cue,
                        time: f64::from(c.time) / 1000.0,
                        loop_end: (c.cue_type == CueType::Loop && c.loop_time > c.time)
                            .then(|| f64::from(c.loop_time) / 1000.0),
                        ..StickCue::default()
                    });
                }
            }
            _ => {}
        }
    }
    let mut extended = Vec::new();
    for content in ext.map(sections).unwrap_or_default() {
        if let Content::ExtendedCueList(list) = content {
            for c in list.cues {
                let (r, g, b) = c.hot_cue_color_rgb;
                let color = if c.hot_cue > 0 {
                    (c.hot_cue_color_index != 0).then(|| hex(r, g, b))
                } else {
                    memory_color(&c.color)
                };
                extended.push(StickCue {
                    hot_cue: c.hot_cue,
                    time: f64::from(c.time) / 1000.0,
                    loop_end: (c.cue_type == CueType::Loop && c.loop_time > c.time)
                        .then(|| f64::from(c.loop_time) / 1000.0),
                    color,
                    name: c.comment.0.clone(),
                });
            }
        }
    }
    out.cues = if extended.is_empty() { basic } else { extended };
    out.cues.sort_by(|a, b| a.time.total_cmp(&b.time));
    out
}
