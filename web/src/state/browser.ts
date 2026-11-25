// What the browser shows: which folder or playlist, the search, the sort, the selection.

import { createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import { camelot, camelotText, keyName } from "../lib/keys";
import type { TrackRec } from "../lib/types";
import { playlists, tracks } from "./library";

export type View = { kind: "collection" } | { kind: "folder"; id: string } | { kind: "playlist"; id: string };
export type SortKey =
  | "title"
  | "artist"
  | "bpm"
  | "key"
  | "duration"
  | "album"
  | "genre"
  | "rating"
  | "dateAdded"
  | "playCount"
  | "order";

export const [view, setView] = createSignal<View>({ kind: "collection" });
export const [search, setSearch] = createSignal("");
export const [sort, setSort] = createSignal<{ key: SortKey; dir: 1 | -1 }>({ key: "dateAdded", dir: -1 });
export const [selected, setSelected] = createSignal<string | null>(null);
/** Every highlighted track (Ctrl-click, Shift-click, Ctrl+A); `selected` is the one
 * keyboard browsing and loading act on, and is always among them. */
export const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
let anchor: string | null = null;

/** A click on a track: `only` picks just it, `toggle` adds or drops it (Ctrl), `range`
 * picks everything from the last clicked track to it (Shift). */
export function pick(id: string, how: "only" | "toggle" | "range") {
  if (how === "range" && anchor) {
    const ids = visible().map((t) => t.id);
    const a = ids.indexOf(anchor);
    const b = ids.indexOf(id);
    if (a >= 0 && b >= 0) {
      setPicked(new Set(ids.slice(Math.min(a, b), Math.max(a, b) + 1)));
      setSelected(id);
      return;
    }
  }
  if (how === "toggle") {
    const next = new Set(picked());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  } else setPicked(new Set([id]));
  anchor = id;
  setSelected(id);
}

export function pickAll() {
  setPicked(new Set(visible().map((t) => t.id)));
}

/** The picked tracks in list order, or the selected one. */
export function pickedIds(): string[] {
  const p = picked();
  if (p.size === 0) return selected() ? [selected()!] : [];
  return visible()
    .map((t) => t.id)
    .filter((id) => p.has(id));
}

/** The playlist on show, if one is. */
export function shownPlaylist() {
  const v = view();
  return v.kind === "playlist" ? playlists().find((p) => p.id === v.id) : undefined;
}

function keyOrder(t: TrackRec): number {
  if (!t.key) return 99;
  const c = camelot(t.key);
  return c.number * 2 + (c.letter === "B" ? 1 : 0);
}

function value(t: TrackRec, k: SortKey): string | number {
  switch (k) {
    case "bpm":
      return t.bpm ?? t.tagBpm ?? 0;
    case "key":
      return keyOrder(t);
    case "duration":
      return t.duration ?? 0;
    case "rating":
      return t.rating;
    case "dateAdded":
      return t.dateAdded;
    case "playCount":
      return t.playCount;
    case "order":
      return 0;
    default:
      return (t[k] ?? "").toString().toLowerCase();
  }
}

export const visible = createRoot(() =>
  createMemo(() => {
    const v = view();
    let list: TrackRec[];
    if (v.kind === "playlist") {
      const p = playlists().find((x) => x.id === v.id);
      const map = new Map(tracks().map((t) => [t.id, t]));
      list = (p?.trackIds ?? []).map((id) => map.get(id)).filter((t): t is TrackRec => !!t);
    } else if (v.kind === "folder") {
      list = tracks().filter((t) => t.folderId === v.id);
    } else {
      list = tracks().slice();
    }
    const q = search().trim().toLowerCase();
    if (q) {
      const words = q.split(/\s+/);
      list = list.filter((t) => {
        const hay = `${t.title} ${t.artist} ${t.album} ${t.genre} ${t.comment} ${camelotText(t.key)} ${keyName(t.key)} ${
          t.bpm ? Math.round(t.bpm) : ""
        }`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const { key, dir } = sort();
    if (key !== "order" || v.kind !== "playlist") {
      list.sort((a, b) => {
        const x = value(a, key);
        const y = value(b, key);
        return (x < y ? -1 : x > y ? 1 : 0) * dir;
      });
    }
    return list;
  }),
);

export function moveSelection(delta: number) {
  const list = visible();
  if (list.length === 0) return;
  const i = list.findIndex((t) => t.id === selected());
  const next = Math.max(0, Math.min(list.length - 1, (i < 0 ? -1 : i) + delta));
  setSelected(list[next].id);
  setPicked(new Set([list[next].id]));
  anchor = list[next].id;
}

// A new view starts with nothing picked.
createRoot(() => createEffect(on(view, () => setPicked(new Set<string>()), { defer: true })));
