// Keyboard shortcuts, by physical key (so they work on any layout). Left hand plays
// deck 1, right hand deck 2. The list in Help comes from here.

import { moveSelection, selected } from "../state/browser";
import { decks } from "../state/deck";
import { trackById } from "../state/library";
import { mixer, setCrossfader } from "../state/mixer";

interface Binding {
  code: string;
  label: string;
  what: string;
  down: (shift: boolean) => void;
  up?: () => void;
}

const d1 = () => decks[0];
const d2 = () => decks[1];
const loadSelected = (i: number) => {
  const id = selected();
  const t = id ? trackById(id) : undefined;
  if (t) void decks[i].load(t);
};
const hot = (deck: () => (typeof decks)[0], i: number) => (shift: boolean) =>
  shift ? deck().deleteHotCue(i) : deck().hotCue(i);

export const BINDINGS: Binding[] = [
  { code: "KeyZ", label: "Z", what: "Deck 1 cue (hold to preview)", down: () => d1().cueDown(), up: () => d1().cueUp() },
  { code: "KeyX", label: "X", what: "Deck 1 play / pause", down: () => d1().togglePlay() },
  { code: "KeyC", label: "C", what: "Deck 1 sync", down: () => d1().setSync(!d1().sync()) },
  { code: "KeyV", label: "V", what: "Deck 1 4-beat loop / exit", down: () => d1().autoLoop(4) },
  { code: "KeyA", label: "A", what: "Deck 1 slow down (hold)", down: () => d1().bend(-0.04), up: () => d1().bend(0) },
  { code: "KeyS", label: "S", what: "Deck 1 speed up (hold)", down: () => d1().bend(0.04), up: () => d1().bend(0) },
  { code: "KeyQ", label: "Q", what: "Deck 1 beat jump back", down: () => d1().beatJump(-d1().jumpBeats()) },
  { code: "KeyW", label: "W", what: "Deck 1 beat jump forward", down: () => d1().beatJump(d1().jumpBeats()) },
  { code: "KeyE", label: "E", what: "Load the selected track to deck 1", down: () => loadSelected(0) },
  { code: "Digit1", label: "1–4", what: "Deck 1 hot cues A–D (Shift deletes)", down: hot(d1, 0) },
  { code: "Digit2", label: "", what: "", down: hot(d1, 1) },
  { code: "Digit3", label: "", what: "", down: hot(d1, 2) },
  { code: "Digit4", label: "", what: "", down: hot(d1, 3) },

  { code: "KeyM", label: "M", what: "Deck 2 cue (hold to preview)", down: () => d2().cueDown(), up: () => d2().cueUp() },
  { code: "Comma", label: ",", what: "Deck 2 play / pause", down: () => d2().togglePlay() },
  { code: "Period", label: ".", what: "Deck 2 sync", down: () => d2().setSync(!d2().sync()) },
  { code: "Slash", label: "/", what: "Deck 2 4-beat loop / exit", down: () => d2().autoLoop(4) },
  { code: "KeyK", label: "K", what: "Deck 2 slow down (hold)", down: () => d2().bend(-0.04), up: () => d2().bend(0) },
  { code: "KeyL", label: "L", what: "Deck 2 speed up (hold)", down: () => d2().bend(0.04), up: () => d2().bend(0) },
  { code: "KeyO", label: "O", what: "Deck 2 beat jump back", down: () => d2().beatJump(-d2().jumpBeats()) },
  { code: "KeyP", label: "P", what: "Deck 2 beat jump forward", down: () => d2().beatJump(d2().jumpBeats()) },
  { code: "KeyI", label: "I", what: "Load the selected track to deck 2", down: () => loadSelected(1) },
  { code: "Digit7", label: "7–0", what: "Deck 2 hot cues A–D (Shift deletes)", down: hot(d2, 0) },
  { code: "Digit8", label: "", what: "", down: hot(d2, 1) },
  { code: "Digit9", label: "", what: "", down: hot(d2, 2) },
  { code: "Digit0", label: "", what: "", down: hot(d2, 3) },

  { code: "ArrowUp", label: "↑ ↓", what: "Move through the track list", down: () => moveSelection(-1) },
  { code: "ArrowDown", label: "", what: "", down: () => moveSelection(1) },
  { code: "BracketLeft", label: "[ ]", what: "Crossfader left / right (\\ centres it)", down: () => setCrossfader(mixer.crossfader - 0.05) },
  { code: "BracketRight", label: "", what: "", down: () => setCrossfader(mixer.crossfader + 0.05) },
  { code: "Backslash", label: "", what: "", down: () => setCrossfader(0.5) },
];

export function installKeyboard(extra: { help: () => void; search: () => void }) {
  const byCode = new Map(BINDINGS.map((b) => [b.code, b]));
  const held = new Set<string>();
  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  };
  window.addEventListener("keydown", (e) => {
    if (typing(e) || e.altKey || e.metaKey) return;
    if (e.ctrlKey) {
      if (e.code === "KeyF") {
        e.preventDefault();
        extra.search();
      }
      return;
    }
    if (e.code === "F1" || (e.shiftKey && e.code === "Slash")) {
      e.preventDefault();
      extra.help();
      return;
    }
    if (e.shiftKey && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
      e.preventDefault();
      loadSelected(e.code === "ArrowLeft" ? 0 : 1);
      return;
    }
    const b = byCode.get(e.code);
    if (!b) return;
    e.preventDefault();
    if (e.repeat) {
      // Only browsing repeats.
      if (e.code === "ArrowUp" || e.code === "ArrowDown") b.down(e.shiftKey);
      return;
    }
    held.add(e.code);
    b.down(e.shiftKey);
  });
  window.addEventListener("keyup", (e) => {
    if (!held.has(e.code)) return;
    held.delete(e.code);
    byCode.get(e.code)?.up?.();
  });
  // A key held while the window loses focus must not stay pressed.
  window.addEventListener("blur", () => {
    for (const code of held) byCode.get(code)?.up?.();
    held.clear();
  });
}
