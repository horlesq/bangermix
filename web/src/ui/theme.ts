export const DECK_COLORS = ["#3db8ff", "#ff4fa3", "#3ddc84", "#ffb020"];
export const HOT_CUE_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

export function deckColor(i: number): string {
  return DECK_COLORS[i % DECK_COLORS.length];
}
