//! What the app sends to an export: tracks with their analysis and cues, and playlists.
//! JSON, camelCase, as the web app writes it.

use serde::Deserialize;

/// A track on the device.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Track {
    /// Where the audio file is on the device, from its root: `/Contents/Artist/Album/file.mp3`.
    pub file_path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub genre: String,
    pub comment: String,
    pub label: String,
    /// The key as players should show it ("8A", "Am"…), or empty.
    pub key: String,
    /// 0 when the track has no beat grid.
    pub bpm: f64,
    /// A downbeat (beat one of a bar), in seconds.
    pub anchor: f64,
    pub duration: f64,
    pub sample_rate: u32,
    pub bit_depth: u16,
    /// kbit/s.
    pub bitrate: u32,
    pub file_size: u64,
    /// File extension, lower case: mp3, m4a, flac, wav, aiff…
    pub file_type: String,
    pub year: u16,
    /// 0 to 5 stars.
    pub rating: u8,
    pub play_count: u16,
    /// `YYYY-MM-DD`.
    pub date_added: String,
    /// The main cue point, in seconds.
    pub cue: Option<f64>,
    pub hot_cues: Vec<HotCue>,
    pub memory_cues: Vec<MemoryCue>,
}

/// A hot cue (or saved loop) on a pad.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HotCue {
    /// 0 = A, 1 = B…
    pub index: u8,
    pub time: f64,
    pub loop_end: Option<f64>,
    /// `#rrggbb`.
    pub color: String,
    pub name: String,
}

/// A memory cue (or memory loop).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MemoryCue {
    pub time: f64,
    pub loop_end: Option<f64>,
    pub name: String,
}

/// A playlist: its folder path (outermost first), name, and tracks as indices into
/// [`Library::tracks`].
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Playlist {
    pub folders: Vec<String>,
    pub name: String,
    pub tracks: Vec<usize>,
}

/// Everything that goes on the device.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Library {
    pub tracks: Vec<Track>,
    pub playlists: Vec<Playlist>,
}
