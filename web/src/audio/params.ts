// Engine parameter ids and state layout. Mirrors crates/bm-engine/src/param.rs:
// keep the two in step.

export const GLOBAL = 255;

export const P = {
  PLAY: 0,
  SEEK: 1,
  TEMPO: 2,
  BEND: 3,
  SCRATCH: 4,
  SCRATCH_SPEED: 5,
  REVERSE: 6,
  LOOP_IN: 7,
  LOOP_OUT: 8,
  LOOP_ON: 9,
  SLIP: 10,
  BEAT: 11,
  ANCHOR: 12,
  SYNC: 13,
  MASTER: 14,
  TRIM: 15,
  EQ_LOW: 16,
  EQ_MID: 17,
  EQ_HIGH: 18,
  FILTER: 19,
  VOLUME: 20,
  CUE: 21,
  ALIGN: 22,
} as const;

export const G = {
  MASTER_GAIN: 0,
  CUE_MIX: 1,
  PHONES_GAIN: 2,
  FX_TYPE: 3,
  FX_TARGET: 4,
  FX_BEATS: 5,
  FX_WET: 6,
  FX_ON: 7,
  FX_PARAM: 8,
} as const;

export const FX = { OFF: 0, ECHO: 1, REVERB: 2, FLANGER: 3, ROLL: 4 } as const;
export const FX_TARGET_MASTER = 4;

export const MAX_DECKS = 4;
export const DECK_STATE = 16;
export const GLOBAL_STATE = MAX_DECKS * DECK_STATE;
export const STATE_LEN = GLOBAL_STATE + 16;

export const S = {
  POS: 0,
  PLAYING: 1,
  SPEED: 2,
  LOADED: 3,
  DURATION: 4,
  LOOP_ON: 5,
  LOOP_IN: 6,
  LOOP_OUT: 7,
  PEAK_L: 8,
  PEAK_R: 9,
  SLIP_POS: 10,
  SLIPPING: 11,
  TEMPO: 12,
  GENERATION: 13,
  PHASE: 14,
} as const;

export const SG = {
  MASTER_PEAK_L: 0,
  MASTER_PEAK_R: 1,
  PHONES_PEAK_L: 2,
  PHONES_PEAK_R: 3,
  LIMITER_GAIN: 4,
  FRAMES: 5,
} as const;
