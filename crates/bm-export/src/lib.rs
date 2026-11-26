//! USB exports for standalone players.
//!
//! - [`pioneer`]: a rekordbox device library for Pioneer / AlphaTheta CDJ and XDJ
//!   players (`export.pdb` and per-track analysis files), the format players since the
//!   CDJ-2000 read, up to the CDJ-3000, CDJ-3000X and XDJ-AZ. Not written: rekordbox
//!   7's encrypted OneLibrary ("Device Library Plus"), which the OPUS-QUAD and
//!   OMNIS-DUO need.
//!
//! The music files themselves are copied by the app; this crate makes the files that
//! describe them.

pub mod anlz;
pub mod model;
pub mod pioneer;
pub mod read;
pub mod waveform;

/// Files packed into one buffer, to hand across the WebAssembly boundary: for each file,
/// a little-endian `u32` path length, the UTF-8 path, a `u32` length and the bytes.
pub fn bundle(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let size: usize = files.iter().map(|(p, b)| 8 + p.len() + b.len()).sum();
    let mut out = Vec::with_capacity(size);
    for (path, bytes) in files {
        out.extend_from_slice(&(path.len() as u32).to_le_bytes());
        out.extend_from_slice(path.as_bytes());
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(bytes);
    }
    out
}

/// Reads a [`bundle`] back.
pub fn unbundle(mut data: &[u8]) -> Option<Vec<(String, Vec<u8>)>> {
    let mut files = Vec::new();
    let take = |n: usize, data: &mut &[u8]| -> Option<Vec<u8>> {
        if data.len() < n {
            return None;
        }
        let (a, b) = data.split_at(n);
        *data = b;
        Some(a.to_vec())
    };
    while !data.is_empty() {
        let n = u32::from_le_bytes(take(4, &mut data)?.try_into().ok()?) as usize;
        let path = String::from_utf8(take(n, &mut data)?).ok()?;
        let n = u32::from_le_bytes(take(4, &mut data)?.try_into().ok()?) as usize;
        files.push((path, take(n, &mut data)?));
    }
    Some(files)
}
