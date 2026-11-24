//! Parameter ids and state layout. Mirrored in `web/src/audio/params.ts`: keep the two
//! in step.

/// The "deck" number that addresses global parameters.
pub const GLOBAL: u32 = 255;

// Deck parameters.
/// 1 plays, 0 pauses.
pub const PLAY: u32 = 0;
/// Jump to this time in the track, in seconds.
pub const SEEK: u32 = 1;
/// Playback speed from the tempo fader, 1 = normal.
pub const TEMPO: u32 = 2;
/// Added to the speed while held (pitch bend / nudge), e.g. 0.04.
pub const BEND: u32 = 3;
/// 1 while the platter is held (scratch or vinyl-mode jog touch).
pub const SCRATCH: u32 = 4;
/// Platter speed while scratching, 1 = normal, negative is backwards.
pub const SCRATCH_SPEED: u32 = 5;
pub const REVERSE: u32 = 6;
/// Loop start and end in seconds; [`LOOP_ON`] switches it.
pub const LOOP_IN: u32 = 7;
pub const LOOP_OUT: u32 = 8;
pub const LOOP_ON: u32 = 9;
pub const SLIP: u32 = 10;
/// Seconds per beat at normal speed, 0 when the track has no grid.
pub const BEAT: u32 = 11;
/// Time of a downbeat in the track, in seconds.
pub const ANCHOR: u32 = 12;
pub const SYNC: u32 = 13;
pub const MASTER: u32 = 14;
/// Channel gain (trim), linear.
pub const TRIM: u32 = 15;
/// EQ band gains, linear (0 = killed).
pub const EQ_LOW: u32 = 16;
pub const EQ_MID: u32 = 17;
pub const EQ_HIGH: u32 = 18;
/// Colour filter knob, -1 (low-pass) to 1 (high-pass).
pub const FILTER: u32 = 19;
/// Channel fader times crossfader, linear.
pub const VOLUME: u32 = 20;
/// 1 sends the channel to the headphones.
pub const CUE: u32 = 21;
/// Line the deck's beats up with the master now (a one-off, value ignored).
pub const ALIGN: u32 = 22;
/// 1 keeps the pitch when the tempo changes (master tempo).
pub const KEYLOCK: u32 = 23;
/// Key shift in semitones, -12 to 12.
pub const KEY_SHIFT: u32 = 24;
/// 1: sync lines up bars (downbeats with downbeats); 0: beats only.
pub const SYNC_BARS: u32 = 25;

// Global parameters.
pub const G_MASTER_GAIN: u32 = 0;
/// 0 = only the cued channels in the headphones, 1 = only the master.
pub const G_CUE_MIX: u32 = 1;
pub const G_PHONES_GAIN: u32 = 2;
/// Beat FX: kind (see [`crate::fx`]), target (deck index or 4 = master), length in
/// beats, wet level 0..1, on/off, and one extra parameter per kind.
pub const G_FX_TYPE: u32 = 3;
pub const G_FX_TARGET: u32 = 4;
pub const G_FX_BEATS: u32 = 5;
pub const G_FX_WET: u32 = 6;
pub const G_FX_ON: u32 = 7;
pub const G_FX_PARAM: u32 = 8;

// Deck state, `DECK_STATE` values per deck.
pub const S_POS: usize = 0;
pub const S_PLAYING: usize = 1;
/// The speed the deck moves at now, 1 = normal (negative backwards, 0 stopped).
pub const S_SPEED: usize = 2;
pub const S_LOADED: usize = 3;
pub const S_DURATION: usize = 4;
pub const S_LOOP_ON: usize = 5;
pub const S_LOOP_IN: usize = 6;
pub const S_LOOP_OUT: usize = 7;
pub const S_PEAK_L: usize = 8;
pub const S_PEAK_R: usize = 9;
pub const S_SLIP_POS: usize = 10;
pub const S_SLIPPING: usize = 11;
/// The tempo the deck plays at, without bends: the fader's, or the synced one.
pub const S_TEMPO: usize = 12;
/// Counts loads, so the interface knows which track the values are about.
pub const S_GENERATION: usize = 13;
/// How far the deck is off the master (in beats), when synced.
pub const S_PHASE: usize = 14;
/// The pitch heard, 1 = the track's own.
pub const S_PITCH: usize = 15;

// Global state, after the decks.
pub const S_MASTER_PEAK_L: usize = 0;
pub const S_MASTER_PEAK_R: usize = 1;
pub const S_PHONES_PEAK_L: usize = 2;
pub const S_PHONES_PEAK_R: usize = 3;
pub const S_LIMITER_GAIN: usize = 4;
pub const S_FRAMES: usize = 5;
