import { Show, createSignal, onCleanup } from "solid-js";
import { startRecording, type Recording } from "../audio/recorder";
import { hidDevices } from "../midi/hid";
import { midiDevices, midiState } from "../midi/midi";
import { audioError, audioReady, audioRunning, maybeEngine } from "../state/app";
import { masterDeck } from "../state/deck";
import { settings, setSettings } from "../state/settings";
import { IconGear, IconHelp, IconRecord } from "./icons";
import { BeatFxSection } from "./FxPanel";

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
  const clock = () => new Date(now()).toTimeString().slice(0, 5);

  return (
    <div class="topbar">
      <div class="brand">
        <img class="brand-mark" src="/icon.svg" alt="" />
        BANGERMIX
      </div>
      <div class="master-bpm" title="Master tempo">
        <span class="section-label">MASTER</span>
        <span class="value">{masterDeck()?.currentBpm() ? masterDeck()!.currentBpm().toFixed(2) : "---.--"}</span>
      </div>
      <BeatFxSection />
      <div class="topbar-right">
        <Show when={audioError()}>
          <span class="pill warn" title={audioError()!}>
            AUDIO ERROR
          </span>
        </Show>
        <Show when={audioReady() && !audioRunning()}>
          <span class="pill warn">CLICK TO START AUDIO</span>
        </Show>
        <span
          class="pill"
          classList={{ lit: (midiState() === "on" && midiDevices().length > 0) || hidDevices().length > 0 }}
          title={
            [
              ...midiDevices().map((d) => `${d.name}: ${d.preset ?? "MIDI learn"}`),
              ...hidDevices().map((d) => `${d.name}: ${d.status}`),
            ].join("\n") || "No controller (Settings → Controllers)"
          }
        >
          MIDI
        </span>
        <div class="seg">
          <button classList={{ on: settings.deckCount === 2 }} onClick={() => setSettings("deckCount", 2)}>
            2 DECK
          </button>
          <button classList={{ on: settings.deckCount === 4 }} onClick={() => setSettings("deckCount", 4)}>
            4 DECK
          </button>
        </div>
        <button class="rec-btn" classList={{ on: !!rec() }} onClick={toggleRec} title="Record the master output">
          <IconRecord size={12} />
          {recTime()}
        </button>
        <span class="clock">{clock()}</span>
        <button class="icon" onClick={p.openHelp} title="Shortcuts (F1)">
          <IconHelp />
        </button>
        <button class="icon" onClick={p.openSettings} title="Settings">
          <IconGear />
        </button>
      </div>
    </div>
  );
}
