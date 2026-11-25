//! A rekordbox device library (what rekordbox writes to a USB stick for CDJ and XDJ
//! players): `PIONEER/rekordbox/export.pdb`, the `*SETTING.DAT` defaults, and the
//! analysis files of each track. The database comes from rekordcrate's `DeviceExport`,
//! which follows rekordbox's layout down to the quirks players depend on.

use crate::anlz;
use crate::model::{Library, Track};
use rekordcrate::device::layout::anlz_folder;
use rekordcrate::util::{ColorIndex, FileType, Rating};
use rekordcrate::{DeviceExport, PlaylistTreeNodeId, TrackId};
use std::collections::HashMap;

/// A file to write on the device: path from its root (starting with `/`) and bytes.
pub type File = (String, Vec<u8>);

/// Where a track's analysis files go. Some players work this out from the audio path
/// themselves (rekordcrate: confirmed on the XDJ-XZ), so it has to be this one.
pub fn analysis_path(file_path: &str, extension: &str) -> String {
    format!(
        "/PIONEER/USBANLZ/{}/ANLZ0000.{extension}",
        anlz_folder(file_path)
    )
}

/// The analysis files of one track.
pub fn track_files(track: &Track, waveform: &[u8], columns_per_s: f64) -> Vec<File> {
    anlz::analysis_files(track, waveform, columns_per_s)
        .into_iter()
        .map(|(ext, bytes)| (analysis_path(&track.file_path, ext), bytes))
        .collect()
}

fn file_type(ext: &str) -> FileType {
    match ext.to_ascii_lowercase().as_str() {
        "mp3" => FileType::Mp3,
        "m4a" | "aac" | "mp4" | "alac" => FileType::M4a,
        "flac" => FileType::Flac,
        "wav" => FileType::Wav,
        "aif" | "aiff" => FileType::Aiff,
        _ => FileType::Unknown,
    }
}

fn row(t: &Track) -> rekordcrate::Track {
    let filename = t
        .file_path
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_owned();
    rekordcrate::Track {
        title: t.title.clone(),
        artist: t.artist.clone(),
        album: t.album.clone(),
        genre: t.genre.clone(),
        key: t.key.clone(),
        label: t.label.clone(),
        comment: t.comment.clone(),
        date_added: t.date_added.clone(),
        file_path: t.file_path.clone(),
        filename,
        tempo: t.bpm.max(0.0) as f32,
        bitrate: t.bitrate,
        sample_rate: t.sample_rate,
        sample_depth: t.bit_depth,
        duration_secs: t.duration.round().clamp(0.0, u16::MAX as f64) as u16,
        file_size: t.file_size.min(u32::MAX as u64) as u32,
        year: t.year,
        play_count: t.play_count,
        rating: Rating::from_stars(t.rating.min(5)),
        color: ColorIndex::None,
        file_type: file_type(&t.file_type),
        // Hot cues load with the track, as rekordbox does by default.
        autoload_hotcues: true,
        ..Default::default()
    }
}

/// The device library: database and setting files, plus every track's analysis
/// (`waveforms[i]` belongs to `library.tracks[i]`).
pub fn database(library: &Library) -> Result<Vec<File>, String> {
    let err = |e: rekordcrate::Error| e.to_string();
    let mut export = DeviceExport::create("").map_err(err)?;
    let mut ids: Vec<TrackId> = Vec::with_capacity(library.tracks.len());
    for t in &library.tracks {
        ids.push(export.add_track(&row(t)).map_err(err)?.id);
    }

    // Folders are shared between playlists that name the same path.
    let mut folders: HashMap<Vec<String>, PlaylistTreeNodeId> = HashMap::new();
    for p in &library.playlists {
        let mut parent = PlaylistTreeNodeId::root();
        for depth in 1..=p.folders.len() {
            let key = p.folders[..depth].to_vec();
            parent = match folders.get(&key) {
                Some(&id) => id,
                None => {
                    let id = export
                        .create_playlist_folder(&p.folders[depth - 1], parent)
                        .map_err(err)?;
                    folders.insert(key, id);
                    id
                }
            };
        }
        let playlist = export.create_playlist(&p.name, parent).map_err(err)?;
        for &i in &p.tracks {
            if let Some(&id) = ids.get(i) {
                export.add_track_to_playlist(playlist, id).map_err(err)?;
            }
        }
    }

    let files = export.save_to_memory().map_err(err)?;
    Ok(files
        .into_iter()
        .map(|(path, bytes)| {
            let p = path.to_string_lossy().replace('\\', "/");
            (format!("/{}", p.trim_start_matches('/')), bytes)
        })
        .collect())
}
