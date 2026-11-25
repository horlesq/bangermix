// A Mixxx mapping wrapped as a controller preset, for MIDI devices. The runtime is
// loaded on first use, so the app doesn't carry it until a controller needs it.

import type { Preset } from "../preset";
import type { CatalogEntry } from "./catalog";
import type { MixxxRuntime } from "./runtime";

export function mixxxPreset(entry: CatalogEntry, status: (s: string) => void): Preset {
  let rt: MixxxRuntime | null = null;
  let stopped = false;
  return {
    name: `${entry.brand} ${entry.model}`,
    start(out) {
      status("loading the mapping…");
      Promise.all([import("./mapping"), import("./runtime")])
        .then(async ([{ loadMapping }, { MixxxRuntime }]) => {
          const m = await loadMapping(entry);
          if (stopped) return;
          const r = new MixxxRuntime(m, { name: entry.model, midi: out });
          r.onError = () => status(`running, with ${r.errors.length} script error${r.errors.length > 1 ? "s" : ""} (see the console)`);
          rt = r;
          r.start();
          if (!r.errors.length) status("ready");
        })
        .catch((e: Error) => status(`could not load the mapping: ${e.message}`));
    },
    stop() {
      stopped = true;
      rt?.stop();
      rt = null;
    },
    message(data) {
      rt?.midiIn(data);
    },
    frame() {
      rt?.flush();
    },
  };
}
