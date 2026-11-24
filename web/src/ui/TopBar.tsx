import { Show, createSignal, onCleanup } from "solid-js";
import { startRecording, type Recording } from "../audio/recorder";
import { midiDevices, midiState } from "../midi/midi";
import { audioError, audioReady, audioRunning, maybeEngine } from "../state/app";
import { settings, setSettings } from "../state/settings";
import { FxPanel } from "./FxPanel";

export function TopBar(p: { openSettings: () => void; openHelp: () => void }) {
  const [rec, setRec] = createSignal<Recording | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 500);
  onCleanup(() => clearInterval(timer));

  const toggleRec = async () => {
    const r = rec();
    if (r) {
      await r.stop();
      setRec(null);
    } else {
      const e = maybeEngine();
      if (e) setRec(startRecording(e));
    }
  };
  const recTime = () => {
    const r = rec();
    if (!r) return "REC";
    const s = Math.floor((now() - r.startedAt) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  return (
    <div class="topbar">
      <div class="logo">
        banger<span>mix</span>
      </div>
      <FxPanel />
      <div class="spacer" />
      <Show when={audioError()}>
        <span class="status warn" title={audioError()!}>
          audio failed
        </span>
      </Show>
      <Show when={audioReady() && !audioRunning()}>
        <span class="status warn">click anywhere to start audio</span>
      </Show>
      <Show when={midiState() === "on"}>
        <span class="status" title={midiDevices().map((d) => `${d.name}: ${d.preset ?? "MIDI learn"}`).join("\n")}>
          MIDI {midiDevices().length ? `· ${midiDevices().length}` : ""}
        </span>
      </Show>
      <div class="seg">
        <button classList={{ on: settings.deckCount === 2 }} onClick={() => setSettings("deckCount", 2)}>
          2 DECK
        </button>
        <button classList={{ on: settings.deckCount === 4 }} onClick={() => setSettings("deckCount", 4)}>
          4 DECK
        </button>
      </div>
      <button class="rec" classList={{ on: !!rec() }} onClick={toggleRec} title="Record the master output">
        ● {recTime()}
      </button>
      <button onClick={p.openHelp} title="Keyboard shortcuts (F1)">
        ?
      </button>
      <button onClick={p.openSettings} title="Settings">
        ⚙
      </button>
    </div>
  );
}
