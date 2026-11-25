// Export playlists to a USB stick for CDJs, XDJs and Denon players.

import { For, Show, createSignal } from "solid-js";
import type { UsbProgress, UsbReport } from "../export/usb";
import { playlists, tracks } from "../state/library";

const canWrite = typeof (window as any).showDirectoryPicker === "function";

/** Whether the dialog is open (the sidebar's USB button opens it). */
export const [usbOpen, setUsbOpen] = createSignal(false);
const PREFS = "bangermix.usb";

export function UsbExport(p: { close: () => void }) {
  const saved = JSON.parse(localStorage.getItem(PREFS) ?? "{}");
  const [chosen, setChosen] = createSignal<Set<string>>(new Set(saved.playlists ?? []));
  const [pioneer, setPioneer] = createSignal<boolean>(saved.pioneer ?? true);
  const [engine, setEngine] = createSignal<boolean>(saved.engine ?? false);
  const [progress, setProgress] = createSignal<UsbProgress | null>(null);
  const [report, setReport] = createSignal<UsbReport | null>(null);
  const [error, setError] = createSignal("");
  let abort: AbortController | null = null;

  const toggle = (id: string) => {
    const s = new Set(chosen());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setChosen(s);
  };
  const lists = () => {
    const picked = playlists()
      .filter((pl) => chosen().has(pl.id))
      .map((pl) => ({ name: pl.name, trackIds: pl.trackIds }));
    // "Collection" exports every track, with no playlist of its own.
    if (chosen().has("*")) picked.unshift({ name: "", trackIds: tracks().map((t) => t.id) });
    return picked;
  };
  const trackCount = () => new Set(lists().flatMap((l) => l.trackIds)).size;

  const start = async () => {
    setError("");
    setReport(null);
    let root: FileSystemDirectoryHandle;
    try {
      root = await (window as any).showDirectoryPicker({ id: "bangermix-usb", mode: "readwrite" });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
      return;
    }
    localStorage.setItem(PREFS, JSON.stringify({ playlists: [...chosen()], pioneer: pioneer(), engine: engine() }));
    abort = new AbortController();
    setProgress({ phase: "Starting", done: 0, total: 1 });
    try {
      // The exporters load on first use.
      const { exportToUsb } = await import("../export/usb");
      setReport(await exportToUsb(root, lists(), { pioneer: pioneer(), engine: engine() }, setProgress, abort.signal));
    } catch (e) {
      setError((e as Error).message || String(e));
    } finally {
      setProgress(null);
      abort = null;
    }
  };

  return (
    <div class="modal-back" onPointerDown={() => !progress() && p.close()}>
      <div class="modal usb" onPointerDown={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <span class="section-label">EXPORT TO USB</span>
          <button onClick={p.close} disabled={!!progress()}>
            ✕
          </button>
        </div>
        <div class="modal-body form">
          <Show when={!canWrite}>
            <p class="note warn">This browser can't write to a USB stick. Use Chrome or Edge.</p>
          </Show>
          <div class="field">
            <span>Players</span>
            <div class="devices">
              <label>
                <input type="checkbox" checked={pioneer()} onChange={(e) => setPioneer(e.currentTarget.checked)} />
                Pioneer DJ / AlphaTheta CDJ and XDJ players (rekordbox USB library)
              </label>
              <label>
                <input type="checkbox" checked={engine()} onChange={(e) => setEngine(e.currentTarget.checked)} />
                Denon DJ: Prime, SC series and other Engine DJ players (Engine 4.1 or newer)
              </label>
            </div>
          </div>
          <div class="field">
            <span>Playlists</span>
            <div class="usb-lists">
              <label>
                <input type="checkbox" checked={chosen().has("*")} onChange={() => toggle("*")} />
                Whole collection ({tracks().length} tracks)
              </label>
              <For each={playlists()}>
                {(pl) => (
                  <label>
                    <input type="checkbox" checked={chosen().has(pl.id)} onChange={() => toggle(pl.id)} />
                    {pl.name} <span class="count">{pl.trackIds.length}</span>
                  </label>
                )}
              </For>
              <Show when={playlists().length === 0}>
                <em>No playlists yet: make one in the browser, or export the whole collection.</em>
              </Show>
            </div>
          </div>
          <p class="note">
            Pick the root of the stick (formatted FAT32 or exFAT). The music is copied to <code>Contents</code>; files
            already there are kept. Grids, cues, loops and waveforms come from bangermix's analysis; unanalysed tracks are
            analysed first. Not tried on hardware yet.
          </p>

          <Show when={progress()}>
            {(pr) => (
              <div class="usb-progress">
                <div>
                  {pr().phase}
                  {pr().total > 1 ? ` ${pr().done + 1} / ${pr().total}` : ""}
                  <Show when={pr().current}>: {pr().current}</Show>
                </div>
                <div class="progress">
                  <div style={{ width: `${Math.round((100 * pr().done) / Math.max(1, pr().total))}%` }} />
                </div>
                <button onClick={() => abort?.abort()}>Cancel</button>
              </div>
            )}
          </Show>
          <Show when={error()}>
            <p class="note warn">{error()}</p>
          </Show>
          <Show when={report()}>
            {(r) => (
              <div class="usb-report">
                <p>
                  Done in {Math.round(r().seconds)} s: {r().tracks} tracks ({r().copied} copied
                  {r().analysed ? `, ${r().analysed} analysed` : ""}). Eject the stick before unplugging it.
                </p>
                <Show when={r().skipped.length}>
                  <p class="note warn">Left out:</p>
                  <ul>
                    <For each={r().skipped}>
                      {(s) => (
                        <li>
                          {s.title}: {s.reason}
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            )}
          </Show>

          <div class="usb-actions">
            <button
              class="primary"
              disabled={!canWrite || !!progress() || trackCount() === 0 || (!pioneer() && !engine())}
              onClick={() => void start()}
            >
              Choose the USB stick and export {trackCount() ? `${trackCount()} tracks` : ""}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
