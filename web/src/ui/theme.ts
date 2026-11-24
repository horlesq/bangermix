// Colours that canvases need (CSS has the same ones as custom properties).

export const DECK_COLORS = ["#4aa3ff", "#ffb347", "#6fd38c", "#c38cff"];
export const HOT_CUE_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

export const COLORS = {
  well: "#0b0b0b",
  playhead: "#ff3b30",
  cue: "#ff9a00",
  loopOn: "rgba(126,217,87,0.22)",
  loopOff: "rgba(255,255,255,0.06)",
  grid: "rgba(255,255,255,0.22)",
  bar: "rgba(255,255,255,0.6)",
  text: "#d9d9d9",
  dim: "#8f8f8f",
  memory: "#ff3b30",
  slip: "#2fa4ff",
};

export function deckColor(i: number): string {
  return DECK_COLORS[i % DECK_COLORS.length];
}
