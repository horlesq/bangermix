import { Show, createEffect, createSignal, on, onMount } from "solid-js";
import { enableMidi } from "./midi/midi";
import { P } from "./audio/params";
import { audioReady, maybeEngine, startAudio, toast } from "./state/app";
import { decks } from "./state/deck";
import { addDropped, foldersNeedingAccess, loadLibrary, reconnect } from "./state/library";
import { applyAll, applyChannel } from "./state/mixer";
import { persistSettings, settings } from "./state/settings";
import { Browser } from "./ui/Browser";
import { DeckPanel } from "./ui/DeckPanel";
import { Help } from "./ui/Help";
import { MixerPanel } from "./ui/MixerPanel";
import { Settings } from "./ui/Settings";
import { TopBar } from "./ui/TopBar";
import { WaveStrip } from "./ui/WaveStrip";
import { startFrameLoop } from "./ui/frame";
import { installKeyboard } from "./ui/keyboard";

export function App() {
  const [showSettings, setShowSettings] = createSignal(false);
  const [showHelp, setShowHelp] = createSignal(false);
  persistSettings();

  onMount(async () => {
    startFrameLoop();
    installKeyboard({
      help: () => setShowHelp(!showHelp()),
      search: () => document.querySelector<HTMLInputElement>(".search")?.focus(),
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        setShowSettings(false);
        setShowHelp(false);
      }
    });
    await Promise.all([loadLibrary(), startAudio()]);
    // Controllers connect without asking when MIDI was allowed before.
    try {
      const status = await navigator.permissions.query({ name: "midi" as PermissionName, sysex: true } as any);
      if (status.state === "granted") void enableMidi();
    } catch {
      /* no permissions API for MIDI */
    }
  });

  createEffect(on(audioReady, (ready) => ready && applyAll()));
  createEffect(() => {
    const bars = settings.syncBars ? 1 : 0;
    if (audioReady()) for (const d of decks) maybeEngine()?.set(d.index, P.SYNC_BARS, bars);
  });
  // Auto gain follows the loaded track.
  for (const d of decks) createEffect(on(d.track, () => applyChannel(d.index)));

  const active = () => decks.slice(0, settings.deckCount);

  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    void addDropped(e.dataTransfer.items);
  };

  return (
    <div class="app" onDragOver={(e) => e.dataTransfer?.types.includes("Files") && e.preventDefault()} onDrop={onDrop}>
      <TopBar openSettings={() => setShowSettings(true)} openHelp={() => setShowHelp(true)} />
      <Show when={foldersNeedingAccess().length > 0}>
        <div class="banner">
          The browser needs a click to read your music folders again:
          {foldersNeedingAccess().map((f) => (
            <button onClick={() => void reconnect(f)}>{f.name}</button>
          ))}
        </div>
      </Show>
      <WaveStrip decks={active()} />
      <div class="decks-row" classList={{ four: settings.deckCount === 4 }}>
        <Show
          when={settings.deckCount === 4}
          fallback={
            <>
              <DeckPanel deck={decks[0]} />
              <MixerPanel channels={[0, 1]} />
              <DeckPanel deck={decks[1]} />
            </>
          }
        >
          <div class="deck-col">
            <DeckPanel deck={decks[0]} compact />
            <DeckPanel deck={decks[2]} compact />
          </div>
          <MixerPanel channels={[2, 0, 1, 3]} compact />
          <div class="deck-col">
            <DeckPanel deck={decks[1]} compact />
            <DeckPanel deck={decks[3]} compact />
          </div>
        </Show>
      </div>
      <Browser />
      <Show when={toast()}>
        <div class="toast">{toast()}</div>
      </Show>
      <Show when={showSettings()}>
        <Settings close={() => setShowSettings(false)} />
      </Show>
      <Show when={showHelp()}>
        <Help close={() => setShowHelp(false)} />
      </Show>
    </div>
  );
}
