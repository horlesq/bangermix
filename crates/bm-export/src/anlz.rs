//! Pioneer analysis files (`PIONEER/USBANLZ/…/ANLZ0000.DAT`, `.EXT`, `.2EX`): beat grid,
//! cues and waveforms for one track.
//!
//! The layout copies what rekordbox writes, section for section (checked against the
//! rekordbox export in rekordcrate's test data): the `.DAT` for every player, the `.EXT`
//! for nexus 2 and later (colour waveforms, hot cue colours and names), the `.2EX` for
//! the CDJ-3000 (3-band waveforms). Field meanings are from Deep Symmetry's
//! "Analysis Files" documentation. Not written: phrase analysis (`PSSI`) and the
//! extended beat grid (`PQT2`); players do without them.
//!
//! Everything here is big-endian, unlike `export.pdb`.

use crate::model::Track;
use crate::waveform::{self, Columns};

/// A tagged section: four-character code, header length, total length, then the rest
/// of the header and the content.
fn section(out: &mut Vec<u8>, tag: &[u8; 4], header_len: u32, body: &[u8]) {
    out.extend_from_slice(tag);
    out.extend_from_slice(&header_len.to_be_bytes());
    out.extend_from_slice(&((12 + body.len()) as u32).to_be_bytes());
    out.extend_from_slice(body);
}

/// A whole file: the `PMAI` header (with the constant values rekordbox writes) and the
/// sections.
fn file(sections: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(28 + sections.len());
    out.extend_from_slice(b"PMAI");
    out.extend_from_slice(&0x1cu32.to_be_bytes());
    out.extend_from_slice(&((28 + sections.len()) as u32).to_be_bytes());
    for v in [1u32, 0x0001_0000, 0x0001_0000, 0] {
        out.extend_from_slice(&v.to_be_bytes());
    }
    out.extend_from_slice(sections);
    out
}

struct Body(Vec<u8>);

impl Body {
    fn new() -> Self {
        Self(Vec::new())
    }
    fn u8(&mut self, v: u8) -> &mut Self {
        self.0.push(v);
        self
    }
    fn u16(&mut self, v: u16) -> &mut Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }
    fn u32(&mut self, v: u32) -> &mut Self {
        self.0.extend_from_slice(&v.to_be_bytes());
        self
    }
    fn bytes(&mut self, v: &[u8]) -> &mut Self {
        self.0.extend_from_slice(v);
        self
    }
}

/// UTF-16BE with a trailing NUL, as paths and cue comments are stored.
fn utf16_nul(s: &str) -> Vec<u8> {
    let mut v: Vec<u8> = s.encode_utf16().flat_map(u16::to_be_bytes).collect();
    v.extend_from_slice(&[0, 0]);
    v
}

fn ms(seconds: f64) -> u32 {
    (seconds.max(0.0) * 1000.0).round() as u32
}

fn path(out: &mut Vec<u8>, file_path: &str) {
    let p = utf16_nul(file_path);
    let mut b = Body::new();
    b.u32(p.len() as u32).bytes(&p);
    section(out, b"PPTH", 16, &b.0);
}

/// Every beat from the first one in the track to the end, numbered within its bar
/// (1-4) counting from the downbeat at `anchor`.
pub fn beats(track: &Track) -> Vec<(u16, f64)> {
    // NaN counts as no grid too.
    if track.bpm.is_nan() || track.bpm <= 0.0 || track.duration.is_nan() || track.duration <= 0.0 {
        return Vec::new();
    }
    let beat = 60.0 / track.bpm;
    let first = (-track.anchor / beat).ceil() as i64;
    let mut out = Vec::new();
    let mut k = first;
    loop {
        let t = track.anchor + k as f64 * beat;
        if t >= track.duration {
            break;
        }
        out.push(((k.rem_euclid(4) + 1) as u16, t));
        k += 1;
    }
    out
}

fn beat_grid(out: &mut Vec<u8>, track: &Track) {
    let beats = beats(track);
    let tempo = (track.bpm * 100.0).round().clamp(0.0, u16::MAX as f64) as u16;
    let mut b = Body::new();
    b.u32(0).u32(0x0008_0000).u32(beats.len() as u32);
    for (number, t) in beats {
        b.u16(number).u16(tempo).u32(ms(t));
    }
    section(out, b"PQTZ", 24, &b.0);
}

/// rekordbox's hot cue palette (Deep Symmetry's Beat Link, `CueList.findRekordboxColor`):
/// players show a hot cue in the colour its code names, and light their pads with the
/// RGB stored beside it.
const HOT_CUE_PALETTE: [u32; 62] = [
    0x305aff, 0x5073ff, 0x508cff, 0x50a0ff, 0x50b4ff, 0x50b0f2, 0x50aee8, 0x45acdb, 0x00e0ff,
    0x19daf0, 0x32d2e6, 0x21b4b9, 0x20aaa0, 0x1fa392, 0x19a08c, 0x14a584, 0x14aa7d, 0x10b176,
    0x30d26e, 0x37de5a, 0x3ceb50, 0x28e214, 0x7dc13d, 0x8cc832, 0x9bd723, 0xa5e116, 0xa5dc0a,
    0xaad208, 0xb4c805, 0xb4be04, 0xbab404, 0xc3af04, 0xe1aa00, 0xffa000, 0xff9600, 0xff8c00,
    0xff7500, 0xe0641b, 0xe0461e, 0xe0301e, 0xe02823, 0xe62828, 0xff376f, 0xff2d6f, 0xff127b,
    0xf51e8c, 0xeb2da0, 0xe637b4, 0xde44cf, 0xde448d, 0xe630b4, 0xe619dc, 0xe600ff, 0xdc00ff,
    0xcc00ff, 0xb432ff, 0xb93cff, 0xc542ff, 0xaa5aff, 0xaa72ff, 0x8272ff, 0x6473ff,
];

/// The palette code nearest to `#rrggbb` (0, "no colour", when it doesn't parse), and
/// that code's RGB.
pub fn hot_cue_color(hex: &str) -> (u8, [u8; 3]) {
    let Ok(rgb) = u32::from_str_radix(hex.trim_start_matches('#'), 16) else {
        return (0, [0; 3]);
    };
    if hex.trim_start_matches('#').len() != 6 {
        return (0, [0; 3]);
    }
    let split = |c: u32| [(c >> 16) as u8, (c >> 8) as u8, c as u8];
    let want = split(rgb);
    let (i, c) = HOT_CUE_PALETTE
        .iter()
        .enumerate()
        .min_by_key(|(_, &c)| {
            let have = split(c);
            (0..3)
                .map(|k| (want[k] as i32 - have[k] as i32).pow(2))
                .sum::<i32>()
        })
        .expect("palette is not empty");
    (i as u8 + 1, split(*c))
}

/// One cue as both cue lists store it.
struct Cue {
    /// 0 for memory cues, 1 = A…
    hot: u32,
    time: f64,
    loop_end: Option<f64>,
    name: String,
    color: (u8, [u8; 3]),
}

fn cues(track: &Track, hot: bool) -> Vec<Cue> {
    let mut list: Vec<Cue> = if hot {
        track
            .hot_cues
            .iter()
            .filter(|c| c.index < 8)
            .map(|c| Cue {
                hot: c.index as u32 + 1,
                time: c.time,
                loop_end: c.loop_end.filter(|&e| e > c.time),
                name: c.name.clone(),
                color: hot_cue_color(&c.color),
            })
            .collect()
    } else {
        // The main cue point goes first, as a memory cue: players load to it.
        let main = track.cue.map(|time| Cue {
            hot: 0,
            time,
            loop_end: None,
            name: String::new(),
            color: (0, [0; 3]),
        });
        let rest = track.memory_cues.iter().map(|c| Cue {
            hot: 0,
            time: c.time,
            loop_end: c.loop_end.filter(|&e| e > c.time),
            name: c.name.clone(),
            color: (0, [0; 3]),
        });
        let mut all: Vec<Cue> = main.into_iter().chain(rest).collect();
        all.dedup_by(|b, a| {
            b.loop_end.is_none() && a.loop_end.is_none() && (a.time - b.time).abs() < 0.001
        });
        all
    };
    list.sort_by_key(|c| (c.hot, ms(c.time)));
    list
}

/// `PCOB`: the original cue list (all players), memory cues (`hot` false) or hot cues.
fn cue_list(out: &mut Vec<u8>, track: &Track, hot: bool) {
    let list = cues(track, hot);
    let n = list.len();
    let mut b = Body::new();
    b.u32(hot as u32)
        .u16(0)
        .u16(n as u16)
        .u32(if n == 0 { 0xffff_ffff } else { n as u32 });
    for (i, c) in list.iter().enumerate() {
        // Sort keys as rekordbox writes them: first is ffff, 0, 2, 3…; last is 1, 2… ffff.
        let order_first = match i {
            0 => 0xffff,
            1 => 0,
            _ => i as u16,
        };
        let order_last = if i + 1 == n { 0xffff } else { i as u16 + 1 };
        let mut e = Body::new();
        e.bytes(b"PCPT")
            .u32(0x1c)
            .u32(0x38)
            .u32(c.hot)
            .u32(0)
            .u32(0x0010_0000)
            .u16(order_first)
            .u16(order_last)
            .u8(if c.loop_end.is_some() { 2 } else { 1 })
            .u8(0)
            .u16(0x03e8)
            .u32(ms(c.time))
            .u32(c.loop_end.map_or(0xffff_ffff, ms))
            .bytes(&[0; 16]);
        b.bytes(&e.0);
    }
    section(out, b"PCOB", 24, &b.0);
}

/// `PCO2`: the nexus 2 cue list, with hot cue colours and names.
fn extended_cue_list(out: &mut Vec<u8>, track: &Track, hot: bool) {
    let list = cues(track, hot);
    let mut b = Body::new();
    b.u32(hot as u32).u16(list.len() as u16).u16(0);
    for c in &list {
        let comment = if c.name.is_empty() {
            Vec::new()
        } else {
            utf16_nul(&c.name)
        };
        let len_entry = 68 + comment.len() as u32;
        let (code, rgb) = c.color;
        let mut e = Body::new();
        e.bytes(b"PCP2")
            .u32(0x10)
            .u32(len_entry)
            .u32(c.hot)
            .u8(if c.loop_end.is_some() { 2 } else { 1 })
            .u8(0)
            .u16(0x03e8)
            .u32(ms(c.time))
            .u32(c.loop_end.map_or(0xffff_ffff, ms))
            .u8(0) // memory cue colour: none
            .bytes(&[0; 7])
            .u16(0) // quantized loop size: not recorded
            .u16(0)
            .u32(comment.len() as u32)
            .bytes(&comment)
            .u8(code)
            .bytes(&rgb)
            .bytes(&[0; 20]);
        b.bytes(&e.0);
    }
    section(out, b"PCO2", 20, &b.0);
}

/// The three analysis files of a track, `(extension, bytes)`.
pub fn analysis_files(
    track: &Track,
    waveform: &[u8],
    columns_per_s: f64,
) -> Vec<(&'static str, Vec<u8>)> {
    let columns = Columns::new(waveform, columns_per_s);
    let duration = track.duration;
    let detail = waveform::detail(&columns, duration);

    // .DAT
    let mut dat = Vec::new();
    path(&mut dat, &track.file_path);
    // VBR seek index: left empty, which players accept (as rekordbox-compatible
    // exporters tested on an XDJ-XZ found).
    section(&mut dat, b"PVBR", 16, &[0; 1608]);
    beat_grid(&mut dat, track);
    let preview: Vec<u8> = waveform::evenly(&columns, duration, 400)
        .iter()
        .map(waveform::mono)
        .collect();
    let mut b = Body::new();
    b.u32(400).u32(0x0001_0000).bytes(&preview);
    section(&mut dat, b"PWAV", 20, &b.0);
    let tiny: Vec<u8> = waveform::evenly(&columns, duration, 100)
        .iter()
        .map(waveform::tiny)
        .collect();
    let mut b = Body::new();
    b.u32(100).u32(0x0001_0000).bytes(&tiny);
    section(&mut dat, b"PWV2", 20, &b.0);
    cue_list(&mut dat, track, true);
    cue_list(&mut dat, track, false);

    // .EXT
    let mut ext = Vec::new();
    path(&mut ext, &track.file_path);
    let mut b = Body::new();
    b.u32(1).u32(detail.len() as u32).u32(0x0096_0000);
    for d in &detail {
        b.u8(waveform::mono(d));
    }
    section(&mut ext, b"PWV3", 24, &b.0);
    cue_list(&mut ext, track, true);
    cue_list(&mut ext, track, false);
    extended_cue_list(&mut ext, track, true);
    extended_cue_list(&mut ext, track, false);
    let mut b = Body::new();
    b.u32(2).u32(detail.len() as u32).u32(0x0096_0305);
    for d in &detail {
        b.bytes(&waveform::color_detail(d));
    }
    section(&mut ext, b"PWV5", 24, &b.0);
    let mut b = Body::new();
    b.u32(6).u32(1200).u32(0);
    for c in waveform::evenly(&columns, duration, 1200) {
        b.bytes(&waveform::color_preview(&c));
    }
    section(&mut ext, b"PWV4", 24, &b.0);

    // .2EX
    let mut two = Vec::new();
    path(&mut two, &track.file_path);
    let mut b = Body::new();
    b.u32(3).u32(detail.len() as u32).u32(0x0096_0000);
    for d in &detail {
        b.bytes(&waveform::three_band(d, 127.0, 250.0));
    }
    section(&mut two, b"PWV7", 24, &b.0);
    let preview3: Vec<[u8; 3]> = waveform::evenly(&columns, duration, 1200)
        .iter()
        .map(|c| waveform::three_band(c, 127.0, 90.0))
        .collect();
    let mut b = Body::new();
    b.u32(3).u32(1200);
    for c in &preview3 {
        b.bytes(c);
    }
    section(&mut two, b"PWV6", 20, &b.0);
    let [low, mid, high] = waveform::three_band_gains(&preview3);
    let mut b = Body::new();
    b.u16(0).u16(low).u16(mid).u16(high);
    section(&mut two, b"PWVC", 14, &b.0);

    vec![
        ("DAT", file(&dat)),
        ("EXT", file(&ext)),
        ("2EX", file(&two)),
    ]
}
