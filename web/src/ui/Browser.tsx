// The library browser: folders and playlists on the left, tracks on the right.

import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { camelotText, compatibility, keyColor, keyName } from "../lib/keys";
import type { PlaylistRec, TrackRec } from "../lib/types";
import { notify } from "../state/app";
import { type SortKey, search, selected, setSearch, setSelected, setSort, setView, sort, view, visible } from "../state/browser";
import { decks, masterDeck } from "../state/deck";
import {
  addDropped,
  addFolder,
  addToPlaylist,
  analysisProgress,
  canPickFolders,
  createPlaylist,
  deletePlaylist,
  folders,
  foldersNeedingAccess,
  isAvailable,
  needsAnalysis,
  playlists,
  reanalyse,
  reconnect,
  removeFolder,
  savePlaylist,
  scanFolder,
  scanStatus,
  tracks,
  updateTrack,
} from "../state/library";
import { settings } from "../state/settings";
import { TRACK_MIME } from "./dnd";
import { deckColor } from "./theme";
import { IconClose, IconCollection, IconFolder, IconPlaylist, IconPlus, IconRefresh, IconSearch, IconUnlink, IconWarn } from "./icons";
import { formatTime } from "./wave";

const ROW = 26;

interface Column {
  key: SortKey;
  label: string;
  width: string;
  cell: (t: TrackRec) => any;
}

export function Browser() {
  return (
    <div class="browser">
      <Sidebar />
      <TrackTable />
    </div>
  );
}

function Sidebar() {
  let fileInput!: HTMLInputElement;
  const isView = (kind: string, id?: string) => {
    const v = view();
    return v.kind === kind && (id === undefined || (v as any).id === id);
  };
  const newPlaylist = async () => {
    const name = prompt("Playlist name");
    if (name) {
      const p = await createPlaylist(name);
      setView({ kind: "playlist", id: p.id });
    }
  };
  const renamePlaylist = async (p: PlaylistRec) => {
    const name = prompt("Rename playlist", p.name);
    if (name) await savePlaylist({ ...p, name });
  };
  return (
    <div class="sidebar">
      <div class="side-item" classList={{ active: isView("collection") }} onClick={() => setView({ kind: "collection" })}>
        <IconCollection size={13} />
        <span class="name">Collection</span>
        <span class="count">{tracks().length}</span>
      </div>

      <div class="side-head">
        <span>FOLDERS</span>
        <Show
          when={canPickFolders}
          fallback={
            <button class="icon mini" onClick={() => fileInput.click()} title="Add music files">
              <IconPlus size={12} />
            </button>
          }
        >
          <button class="icon mini" onClick={() => addFolder().catch(() => {})} title="Add a music folder">
            <IconPlus size={12} />
          </button>
        </Show>
      </div>
      <For each={folders()}>
        {(f) => (
          <div class="side-item" classList={{ active: isView("folder", f.id) }} onClick={() => setView({ kind: "folder", id: f.id })}>
            <IconFolder size={13} />
            <span class="name">{f.name}</span>
            <Show when={f.handle && foldersNeedingAccess().some((x) => x.id === f.id)}>
              <button
                class="mini warn"
                onClick={(e) => {
                  e.stopPropagation();
                  void reconnect(f);
                }}
                title="The browser needs your OK to read this folder again"
              >
                RECONNECT
              </button>
            </Show>
            <Show when={f.handle}>
              <button
                class="mini ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  void scanFolder(f);
                }}
                title="Look for new files"
              >
                <IconRefresh size={12} />
              </button>
            </Show>
            <button
              class="mini ghost"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Remove ${f.name} from the library? (The files stay where they are.)`)) void removeFolder(f);
              }}
              title="Remove from the library"
            >
              <IconClose size={11} />
            </button>
          </div>
        )}
      </For>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept="audio/*,.mp3,.flac,.wav,.aif,.aiff,.m4a,.ogg"
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          if (files.length) void addDropped(files);
          e.currentTarget.value = "";
        }}
      />

      <div class="side-head">
        <span>PLAYLISTS</span>
        <button class="icon mini" onClick={newPlaylist} title="New playlist">
          <IconPlus size={12} />
        </button>
      </div>
      <For each={playlists()}>
        {(p) => (
          <div
            class="side-item"
            classList={{ active: isView("playlist", p.id) }}
            onClick={() => setView({ kind: "playlist", id: p.id })}
            onDblClick={() => renamePlaylist(p)}
            onDragOver={(e) => {
              if (e.dataTransfer?.types.includes(TRACK_MIME)) e.preventDefault();
            }}
            onDrop={(e) => {
              const id = e.dataTransfer?.getData(TRACK_MIME);
              if (id) void addToPlaylist(p, [id]).then(() => notify(`Added to ${p.name}`));
            }}
          >
            <IconPlaylist size={13} />
            <span class="name">{p.name}</span>
            <span class="count">{p.trackIds.length}</span>
            <button
              class="mini ghost"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Delete the playlist ${p.name}?`)) void deletePlaylist(p);
              }}
              title="Delete playlist"
            >
              <IconClose size={11} />
            </button>
          </div>
        )}
      </For>

      <div class="side-status">
        <Show when={scanStatus()}>
          <div>{scanStatus()}</div>
        </Show>
        <Show when={analysisProgress().total > 0}>
          <div>
            Analysing {analysisProgress().done} / {analysisProgress().total}
            <div class="progress">
              <div style={{ width: `${(analysisProgress().done / analysisProgress().total) * 100}%` }} />
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}

function TrackTable() {
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [height, setHeight] = createSignal(400);
  const [menu, setMenu] = createSignal<{ x: number; y: number; track: TrackRec } | null>(null);

  onMount(() => {
    const ro = new ResizeObserver(() => setHeight(scroller.clientHeight));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    const close = () => setMenu(null);
    window.addEventListener("pointerdown", close);
    onCleanup(() => window.removeEventListener("pointerdown", close));
  });

  // Keep the selected row in view when it moves by keyboard.
  createEffect(() => {
    const id = selected();
    const i = visible().findIndex((t) => t.id === id);
    if (i < 0 || !scroller) return;
    const top = i * ROW;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + ROW - scroller.clientHeight;
  });

  const loadedOn = createMemo(() => {
    const m = new Map<string, number[]>();
    for (const d of decks) {
      const t = d.track();
      if (t) m.set(t.id, [...(m.get(t.id) ?? []), d.index]);
    }
    return m;
  });

  const reference = () => {
    const m = masterDeck();
    return m?.track() ? m : decks.find((d) => d.live.playing && d.track());
  };

  const keyMatch = (t: TrackRec) => {
    const r = reference()?.track();
    if (!r?.key || !t.key || r.id === t.id) return false;
    return compatibility(r.key, t.key) >= 0.9;
  };
  const bpmMatch = (t: TrackRec) => {
    const r = reference();
    if (!r || !t.bpm || r.track()?.id === t.id) return false;
    const target = r.currentBpm();
    return [0.5, 1, 2].some((m) => Math.abs((t.bpm! * m) / target - 1) < 0.06);
  };

  const columns: Column[] = [
    {
      key: "title",
      label: "Title",
      width: "minmax(180px, 3fr)",
      cell: (t) => (
        <span class="title-cell">
          <For each={loadedOn().get(t.id) ?? []}>
            {(i) => (
              <span class="on-deck" style={{ background: deckColor(i) }}>
                {i + 1}
              </span>
            )}
          </For>
          <Show when={!isAvailable(t)}>
            <span class="status" title="Not reachable now: reconnect its folder or drop the file in again">
              <IconUnlink size={11} />
            </span>
          </Show>
          <Show when={t.analysisError}>
            <span class="status warn" title={t.analysisError}>
              <IconWarn size={11} />
            </span>
          </Show>
          {t.title}
        </span>
      ),
    },
    { key: "artist", label: "Artist", width: "minmax(120px, 2fr)", cell: (t) => t.artist },
    {
      key: "bpm",
      label: "BPM",
      width: "62px",
      cell: (t) => (
        <span class="num-cell" classList={{ match: bpmMatch(t), pending: needsAnalysis(t) }}>
          {t.bpm ? t.bpm.toFixed(t.bpm % 1 ? 2 : 0) : t.tagBpm ? `${t.tagBpm}*` : needsAnalysis(t) ? "…" : ""}
        </span>
      ),
    },
    {
      key: "key",
      label: "Key",
      width: "50px",
      cell: (t) => (
        <span class="key-cell" classList={{ match: keyMatch(t) }} style={{ color: keyColor(t.key) }}>
          {settings.keyNotation === "camelot" ? camelotText(t.key) : keyName(t.key)}
        </span>
      ),
    },
    { key: "duration", label: "Time", width: "58px", cell: (t) => (t.duration ? formatTime(t.duration).slice(0, 5) : "") },
    { key: "album", label: "Album", width: "minmax(100px, 1.5fr)", cell: (t) => t.album },
    { key: "genre", label: "Genre", width: "minmax(70px, 1fr)", cell: (t) => t.genre },
    {
      key: "rating",
      label: "Rating",
      width: "78px",
      cell: (t) => (
        <span class="stars">
          <For each={[1, 2, 3, 4, 5]}>
            {(n) => (
              <i
                classList={{ lit: t.rating >= n }}
                onClick={(e) => {
                  e.stopPropagation();
                  updateTrack(t.id, { rating: t.rating === n ? 0 : n });
                }}
              >
                ★
              </i>
            )}
          </For>
        </span>
      ),
    },
    { key: "playCount", label: "Plays", width: "48px", cell: (t) => t.playCount || "" },
    {
      key: "dateAdded",
      label: "Added",
      width: "84px",
      cell: (t) => new Date(t.dateAdded).toISOString().slice(0, 10),
    },
  ];
  const template = columns.map((c) => c.width).join(" ");

  const range = createMemo(() => {
    const start = Math.max(0, Math.floor(scrollTop() / ROW) - 8);
    const end = Math.min(visible().length, Math.ceil((scrollTop() + height()) / ROW) + 8);
    return { start, end };
  });

  const loadToFree = (t: TrackRec) => {
    const free = decks.slice(0, settings.deckCount).find((d) => !d.live.playing && !d.track()) ??
      decks.slice(0, settings.deckCount).find((d) => !d.live.playing);
    if (free) void free.load(t);
    else notify("Every deck is playing.");
  };

  const headerClick = (k: SortKey) => {
    const s = sort();
    setSort({ key: k, dir: s.key === k ? (-s.dir as 1 | -1) : k === "dateAdded" || k === "rating" || k === "playCount" ? -1 : 1 });
  };

  return (
    <div class="tracks">
      <div class="tracks-bar">
        <IconSearch size={13} />
        <input
          class="search"
          placeholder="Search  (title, artist, key 8A, BPM)"
          value={search()}
          onInput={(e) => setSearch(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setSearch("");
              e.currentTarget.blur();
            }
          }}
        />
        <span class="count">{visible().length} TRACKS</span>
        <Show when={view().kind === "playlist"}>
          <button class="mini" onClick={() => setSort({ key: "order", dir: 1 })} classList={{ on: sort().key === "order" }}>
            PLAYLIST ORDER
          </button>
        </Show>
      </div>
      <div class="thead" style={{ "grid-template-columns": template }}>
        <For each={columns}>
          {(c) => (
            <div onClick={() => headerClick(c.key)} classList={{ sorted: sort().key === c.key }}>
              {c.label}
              {sort().key === c.key ? (sort().dir > 0 ? " ▲" : " ▼") : ""}
            </div>
          )}
        </For>
      </div>
      <div class="tbody" ref={scroller} onScroll={() => setScrollTop(scroller.scrollTop)}>
        <Show when={visible().length === 0}>
          <EmptyLibrary />
        </Show>
        <div style={{ height: `${visible().length * ROW}px`, position: "relative" }}>
          <For each={visible().slice(range().start, range().end)}>
            {(t, i) => (
              <div
                class="trow"
                classList={{ sel: selected() === t.id, missing: !isAvailable(t), odd: (range().start + i()) % 2 === 1 }}
                style={{ top: `${(range().start + i()) * ROW}px`, "grid-template-columns": template }}
                draggable={true}
                onDragStart={(e) => {
                  e.dataTransfer!.setData(TRACK_MIME, t.id);
                  e.dataTransfer!.effectAllowed = "copy";
                }}
                onPointerDown={() => setSelected(t.id)}
                onDblClick={() => loadToFree(t)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelected(t.id);
                  setMenu({ x: e.clientX, y: e.clientY, track: t });
                }}
              >
                <For each={columns}>{(c) => <div>{c.cell(t)}</div>}</For>
              </div>
            )}
          </For>
        </div>
      </div>
      <Show when={menu()}>
        <RowMenu {...menu()!} close={() => setMenu(null)} />
      </Show>
    </div>
  );
}

function RowMenu(p: { x: number; y: number; track: TrackRec; close: () => void }) {
  const v = view();
  const act = (f: () => void) => (e: PointerEvent) => {
    e.stopPropagation();
    f();
    p.close();
  };
  return (
    <div class="menu" style={{ left: `${p.x}px`, top: `${p.y}px` }} onPointerDown={(e) => e.stopPropagation()}>
      <For each={decks.slice(0, settings.deckCount)}>
        {(d) => <div onPointerDown={act(() => void d.load(p.track))}>Load to deck {d.index + 1}</div>}
      </For>
      <hr />
      <For each={playlists()}>
        {(pl) => <div onPointerDown={act(() => void addToPlaylist(pl, [p.track.id]).then(() => notify(`Added to ${pl.name}`)))}>Add to {pl.name}</div>}
      </For>
      <Show when={v.kind === "playlist"}>
        <div
          onPointerDown={act(() => {
            const pl = playlists().find((x) => x.id === (v as any).id);
            if (pl) void savePlaylist({ ...pl, trackIds: pl.trackIds.filter((id) => id !== p.track.id) });
          })}
        >
          Remove from playlist
        </div>
      </Show>
      <hr />
      <div onPointerDown={act(() => reanalyse([p.track.id]))}>Analyse again</div>
      <div onPointerDown={act(() => updateTrack(p.track.id, { hotCues: Array(8).fill(null), memoryCues: [], cue: undefined }))}>
        Clear cues
      </div>
    </div>
  );
}

function EmptyLibrary() {
  return (
    <div class="empty-library">
      <div class="empty-title">No tracks</div>
      <Show when={canPickFolders} fallback={<p>Drop audio files on this window, or use + next to Folders.</p>}>
        <p>Add your music folder, or drop files and folders on this window.</p>
        <button onClick={() => addFolder().catch(() => {})}>ADD MUSIC FOLDER</button>
      </Show>
      <p class="hint">MP3 · FLAC · WAV · AIFF · M4A · OGG — files stay on this computer.</p>
    </div>
  );
}
