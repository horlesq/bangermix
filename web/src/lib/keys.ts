// Musical keys: names, Camelot notation and which keys mix well.

import type { MusicalKey } from "./types";

const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

export function camelot(k: MusicalKey): { number: number; letter: "A" | "B" } {
  // Each step round the wheel is a fifth. A minor is 8A, C major is 8B.
  const reference = k.minor ? 9 : 0;
  const steps = (((7 * (k.tonic - reference)) % 12) + 12) % 12;
  return { number: ((steps + 7) % 12) + 1, letter: k.minor ? "A" : "B" };
}

export function camelotText(k: MusicalKey | undefined): string {
  if (!k) return "";
  const c = camelot(k);
  return `${c.number}${c.letter}`;
}

export function keyName(k: MusicalKey | undefined): string {
  if (!k) return "";
  return NAMES[k.tonic] + (k.minor ? "m" : "");
}

/** Reads keys as tags carry them: Camelot (8A), Open Key (9m), or names (F#m, Ebm, C). */
export function parseKey(text: string | undefined): MusicalKey | undefined {
  if (!text) return undefined;
  const t = text.trim();
  const m = /^(\d{1,2})\s*([abdmABDM])$/.exec(t);
  if (m) {
    const n = parseInt(m[1]);
    if (n < 1 || n > 12) return undefined;
    const l = m[2].toLowerCase();
    const minor = l === "a" || l === "m";
    const offset = l === "a" || l === "b" ? 8 : 1;
    const reference = minor ? 9 : 0;
    return { tonic: ((((reference + 7 * (n - offset)) % 12) + 12) % 12), minor };
  }
  const n = /^([A-Ga-g])([#b♯♭]?)\s*(m|min|minor|maj|major)?$/.exec(t);
  if (!n) return undefined;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[n[1].toUpperCase() as "C"];
  const acc = n[2] === "#" || n[2] === "♯" ? 1 : n[2] === "b" || n[2] === "♭" ? -1 : 0;
  const minor = !!n[3] && n[3].startsWith("m") && !n[3].startsWith("maj");
  return { tonic: (base + acc + 12) % 12, minor };
}

/** 0 (clash) to 1 (same key), following the Camelot wheel. */
export function compatibility(a: MusicalKey, b: MusicalKey): number {
  const ca = camelot(a);
  const cb = camelot(b);
  const diff = (((ca.number - cb.number) % 12) + 12) % 12;
  const distance = Math.min(diff, 12 - diff);
  const same = ca.letter === cb.letter;
  if (distance === 0) return same ? 1 : 0.9;
  if (distance === 1) return same ? 0.9 : 0.6;
  if (distance === 2 && same) return 0.6;
  return 0.1;
}

/** A colour per Camelot number, round the wheel. */
export function keyColor(k: MusicalKey | undefined): string {
  if (!k) return "var(--muted)";
  const c = camelot(k);
  const hue = ((c.number - 1) * 30 + 200) % 360;
  return `hsl(${hue} 80% ${c.letter === "A" ? 68 : 78}%)`;
}
