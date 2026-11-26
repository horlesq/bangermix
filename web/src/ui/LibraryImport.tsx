// Brings another DJ app's library in: grids, cues, loops, keys, ratings and playlists from
// rekordbox, Serato, Traktor, Engine DJ, Mixxx or VirtualDJ, or a prepared USB stick.

import { For, Show, createSignal } from "solid-js";
import type { ImportedLibrary, ImportProgress, ImportReport } from "../import/model";
import type { PickedFolder } from "../import/folder";
import { canPickFolders, folders } from "../state/library";

/** Whether the dialog is open. */
export const [importOpen, setImportOpen] = createSignal(false);

type Picks = typeof import("../import/folder");
type Sources = typeof import("../import/sources");

interface Source {
  id: string;
  app: string;
  what: string;
  where: string;
  button: string;
  note?: string;
  run: (s: Sources, f: Picks, addMusic: boolean, progress: (p: ImportProgress) => void) => Promise<ImportedLibrary[] | undefined>;
}

const folder = async (f: Picks, run: (folder: PickedFolder) => Promise<ImportedLibrary | undefined>) => {
  const picked = await f.pickFolder();
  if (!picked) return undefined;
  const lib = await run(picked);
  return lib ? [lib] : undefined;
};
const file = async (f: Picks, accept: string, run: (file: File) => Promise<ImportedLibrary>) => {
  const picked = await f.pickFile(accept);
  return picked ? [await run(picked)] : undefined;
};

const SOURCES: Source[] = [
  {
    id: "stick",
    app: "USB stick",
    what: "A stick prepared in rekordbox or Engine DJ: its tracks, grids, cues, loops and playlists.",
    where: "Pick the stick itself (its top folder).",
    button: "CHOOSE THE STICK",
    run: async (s, f, addMusic, progress) => {
      const picked = await f.pickFolder();
      return picked ? s.fromStick(picked, addMusic, progress) : undefined;
    },
  },
  {
    id: "rekordbox",
    app: "rekordbox",
    what: "Beat grids, keys, hot cues, memory cues, loops, ratings and playlists.",
    where: "In rekordbox: File → Export Collection in xml format.",
    button: "CHOOSE REKORDBOX.XML",
    run: (s, f) => file(f, ".xml", s.fromRekordboxXml),
  },
  {
    id: "serato",
    app: "Serato DJ",
    what: "Crates, beat grids, hot cues (with names and colours) and saved loops.",
    where: "Pick the _Serato_ folder: in your Music folder, or at the top of an external drive for music on it.",
    button: "CHOOSE THE _SERATO_ FOLDER",
    run: (s, f) => folder(f, s.fromSerato),
  },
  {
    id: "traktor",
    app: "Traktor",
    what: "Beat grids, keys, cues, loops, ratings and playlists.",
    where: "Documents → Native Instruments → Traktor (version) → collection.nml.",
    button: "CHOOSE COLLECTION.NML",
    run: (s, f) => file(f, ".nml", s.fromTraktor),
  },
  {
    id: "engine",
    app: "Engine DJ",
    what: "Beat grids, keys, hot cues, main cue, saved loops, ratings and playlists (Engine DJ 2 or newer).",
    where: "Pick the Engine Library folder, in your Music folder.",
    button: "CHOOSE ENGINE LIBRARY",
    run: (s, f) => folder(f, (picked) => s.fromEngine(picked)),
  },
  {
    id: "mixxx",
    app: "Mixxx",
    what: "Beat grids, keys, hot cues, loops, ratings, playlists and crates.",
    where:
      "mixxxdb.sqlite: on Windows in %LOCALAPPDATA%\\Mixxx, on macOS in ~/Library/Containers/org.mixxx.mixxx/Data/Library/Application Support/Mixxx, on Linux in ~/.mixxx.",
    button: "CHOOSE MIXXXDB.SQLITE",
    run: (s, f) => file(f, ".sqlite,.db", s.fromMixxx),
  },
  {
    id: "virtualdj",
    app: "VirtualDJ",
    what: "BPM, keys, ratings, hot cues and playlists (My Lists).",
    where: "Pick the VirtualDJ folder in Documents.",
    button: "CHOOSE THE VIRTUALDJ FOLDER",
    note: "Hot cues and grids from VirtualDJ haven't been tried on real files yet.",
    run: (s, f) => folder(f, s.fromVirtualDj),
  },
];

export function LibraryImport(p: { close: () => void }) {
  const [busy, setBusy] = createSignal(false);
  const [progress, setProgress] = createSignal<ImportProgress | null>(null);
  const [reports, setReports] = createSignal<ImportReport[]>([]);
  const [error, setError] = createSignal("");
  const [addMusic, setAddMusic] = createSignal(true);

  const run = async (source: Source) => {
    setError("");
    setReports([]);
    setBusy(true);
    try {
      // The readers load on first use.
      const [s, f, { applyImport }] = await Promise.all([
        import("../import/sources"),
        import("../import/folder"),
        import("../import/apply"),
      ]);
      const libs = await source.run(s, f, addMusic(), setProgress);
      if (!libs) return;
      const out: ImportReport[] = [];
      for (const lib of libs) out.push(await applyImport(lib, setProgress));
      setReports(out);
    } catch (e) {
      setError((e as Error).message || String(e));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div class="modal-back" onPointerDown={() => !busy() && p.close()}>
      <div class="modal import" onPointerDown={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <span class="section-label">IMPORT FROM ANOTHER DJ APP</span>
          <button onClick={p.close} disabled={busy()}>
            ✕
          </button>
        </div>
        <div class="modal-body form">
          <p class="note">
            Your music stays where it is: tracks are matched to the files already in the library by name and size, so add
            your music folders first
            {folders().length ? "" : " (none yet)"}. Playlists come in under the app's name, and importing again updates
            them.
          </p>
          <div class="import-sources">
            <For each={SOURCES}>
              {(s) => (
                <div class="import-source">
                  <div class="import-text">
                    <b>{s.app}</b>
                    <span>{s.what}</span>
                    <span class="where">{s.where}</span>
                    <Show when={s.note}>
                      <span class="where warn">{s.note}</span>
                    </Show>
                    <Show when={s.id === "stick" && canPickFolders}>
                      <label class="where">
                        <input type="checkbox" checked={addMusic()} onChange={(e) => setAddMusic(e.currentTarget.checked)} />
                        Add the stick's music to the library too
                      </label>
                    </Show>
                  </div>
                  <button disabled={busy()} onClick={() => void run(s)}>
                    {s.button}
                  </button>
                </div>
              )}
            </For>
          </div>

          <Show when={progress()}>
            {(pr) => (
              <div class="usb-progress">
                <div>
                  {pr().phase}
                  {pr().total > 1 ? ` ${pr().done} / ${pr().total}` : ""}
                </div>
                <div class="progress">
                  <div style={{ width: `${Math.round((100 * pr().done) / Math.max(1, pr().total))}%` }} />
                </div>
              </div>
            )}
          </Show>
          <Show when={error()}>
            <p class="note warn">{error()}</p>
          </Show>
          <For each={reports()}>
            {(r) => (
              <div class="usb-report">
                <p>
                  <b>{r.source}:</b> matched {r.matched} of {r.inSource} tracks
                  {r.withCues ? ` (${r.withCues} with grids or cues)` : ""}, {r.playlists} playlist
                  {r.playlists === 1 ? "" : "s"}.
                </p>
                <Show when={r.missingCount > 0}>
                  <p class="note warn">
                    Not in the library ({r.missingCount}): {r.missing.join(", ")}
                    {r.missingCount > r.missing.length ? "…" : ""}. Add the folders they're in, then import again.
                  </p>
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
