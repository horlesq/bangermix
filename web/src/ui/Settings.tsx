import { For, Show, createResource, createSignal } from "solid-js";
import { outputDevices, type OutputMode } from "../audio/engine";
import { ACTIONS } from "../midi/actions";
import { enableMidi, forget, learned, learning, lastMessage, midiDevices, midiState, setLearning } from "../midi/midi";
import { maybeEngine } from "../state/app";
import { reanalyse, tracks } from "../state/library";
import { applyAll } from "../state/mixer";
import { type CrossfaderCurve, settings, setSettings } from "../state/settings";

export function Settings(p: { close: () => void }) {
  const [tab, setTab] = createSignal<"audio" | "decks" | "library" | "midi">("audio");
  return (
    <div class="modal-back" onPointerDown={p.close}>
      <div class="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <div class="seg">
            <For each={["audio", "decks", "library", "midi"] as const}>
              {(t) => (
                <button classList={{ on: tab() === t }} onClick={() => setTab(t)}>
                  {t.toUpperCase()}
                </button>
              )}
            </For>
          </div>
          <button onClick={p.close}>✕</button>
        </div>
        <div class="modal-body">
          <Show when={tab() === "audio"}>
            <AudioSettings />
          </Show>
          <Show when={tab() === "decks"}>
            <DeckSettings />
          </Show>
          <Show when={tab() === "library"}>
            <LibrarySettings />
          </Show>
          <Show when={tab() === "midi"}>
            <MidiSettings />
          </Show>
        </div>
      </div>
    </div>
  );
}

function AudioSettings() {
  const [devices, { refetch }] = createResource(outputDevices);
  const e = maybeEngine();
  const askNames = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
    } catch {
      /* names stay hidden */
    }
    void refetch();
  };
  const setMode = (m: OutputMode) => {
    setSettings("outputMode", m);
    maybeEngine()?.setMode(m);
  };
  return (
    <div class="form">
      <label>
        Output device
        <select
          value={settings.sinkId}
          onChange={(ev) => {
            setSettings("sinkId", ev.currentTarget.value);
            void maybeEngine()?.setSink(ev.currentTarget.value);
          }}
        >
          <For each={devices() ?? []}>
            {(d, i) => <option value={d.deviceId}>{d.label || `Output ${i() + 1}`}</option>}
          </For>
        </select>
        <button class="mini" onClick={askNames} title="Browsers show device names only after a microphone permission">
          show names
        </button>
      </label>
      <div class="field">
        <span>Headphone cue</span>
        <div class="radio">
          <label>
            <input type="radio" checked={settings.outputMode === "stereo"} onChange={() => setMode("stereo")} />
            Off: master on outputs 1–2
          </label>
          <label>
            <input type="radio" checked={settings.outputMode === "quad"} onChange={() => setMode("quad")} />
            4 outputs: master on 1–2, headphones on 3–4 (a DJ controller's sound card)
            <Show when={e && e.maxChannels < 4}>
              <em> — this device has {e!.maxChannels} outputs</em>
            </Show>
          </label>
          <label>
            <input type="radio" checked={settings.outputMode === "split"} onChange={() => setMode("split")} />
            Split: master in mono on the left, headphones on the right (splitter cable)
          </label>
        </div>
      </div>
      <p class="note">
        Latency: {e ? `${Math.round(e.latency * 1000)} ms output, ${e.ctx.sampleRate} Hz` : "audio not started"}.{" "}
        {e && !e.shared ? "Shared memory is off (the page is not cross-origin isolated): meters update less often." : ""}
      </p>
    </div>
  );
}

function DeckSettings() {
  return (
    <div class="form">
      <label>
        Decks
        <select value={settings.deckCount} onChange={(e) => setSettings("deckCount", Number(e.currentTarget.value) as 2 | 4)}>
          <option value={2}>2</option>
          <option value={4}>4</option>
        </select>
      </label>
      <label>
        Tempo range for new decks
        <select value={settings.tempoRange} onChange={(e) => setSettings("tempoRange", Number(e.currentTarget.value))}>
          <For each={[6, 10, 16, 100]}>{(r) => <option value={r}>±{r === 100 ? "100 (wide)" : r}%</option>}</For>
        </select>
      </label>
      <label>
        Crossfader curve
        <select
          value={settings.crossfaderCurve}
          onChange={(e) => {
            setSettings("crossfaderCurve", e.currentTarget.value as CrossfaderCurve);
            applyAll();
          }}
        >
          <option value="smooth">Smooth (blend)</option>
          <option value="linear">Linear</option>
          <option value="cut">Cut (scratch)</option>
        </select>
      </label>
      <label>
        <input type="checkbox" checked={settings.quantize} onChange={(e) => setSettings("quantize", e.currentTarget.checked)} />
        Quantize: cues, loops and jumps snap to the beat
      </label>
      <label>
        <input type="checkbox" checked={settings.vinyl} onChange={(e) => setSettings("vinyl", e.currentTarget.checked)} />
        Vinyl mode: touching a jog wheel or waveform scratches (off: it nudges)
      </label>
      <label>
        <input
          type="checkbox"
          checked={settings.autoGain}
          onChange={(e) => {
            setSettings("autoGain", e.currentTarget.checked);
            applyAll();
          }}
        />
        Auto gain: level tracks to the same loudness
      </label>
      <label>
        Key notation
        <select value={settings.keyNotation} onChange={(e) => setSettings("keyNotation", e.currentTarget.value as "camelot")}>
          <option value="camelot">Camelot (8A)</option>
          <option value="musical">Musical (Am)</option>
        </select>
      </label>
    </div>
  );
}

function LibrarySettings() {
  return (
    <div class="form">
      <label>
        BPM range for analysis
        <input
          type="number"
          value={settings.bpmMin}
          min={50}
          max={150}
          onChange={(e) => setSettings("bpmMin", Number(e.currentTarget.value))}
        />
        to
        <input
          type="number"
          value={settings.bpmMax}
          min={80}
          max={250}
          onChange={(e) => setSettings("bpmMax", Number(e.currentTarget.value))}
        />
      </label>
      <p class="note">
        Keep the top under twice the bottom, so every track has one answer (87 or 174). Drum and bass: 120–200; house and
        techno: 88–175; hip hop: 70–140.
      </p>
      <button onClick={() => reanalyse(tracks().map((t) => t.id))}>Analyse the whole library again</button>
      <p class="note">Grids you edited by hand are kept.</p>
    </div>
  );
}

function MidiSettings() {
  const [filter, setFilter] = createSignal("");
  const keyFor = (id: string) =>
    Object.entries(learned())
      .filter(([, a]) => a === id)
      .map(([k]) => k);
  return (
    <div class="form">
      <Show when={midiState() !== "on"}>
        <button onClick={() => void enableMidi()}>Connect MIDI controllers</button>
        <Show when={midiState() === "denied"}>
          <p class="note">The browser refused MIDI access. Allow it in the site settings.</p>
        </Show>
        <Show when={midiState() === "unsupported"}>
          <p class="note">This browser has no Web MIDI. Use Chrome or Edge.</p>
        </Show>
      </Show>
      <Show when={midiState() === "on"}>
        <div class="field">
          <span>Devices</span>
          <div>
            <Show when={midiDevices().length === 0}>
              <em>None connected.</em>
            </Show>
            <For each={midiDevices()}>
              {(d) => (
                <div>
                  {d.name} — {d.preset ?? "no preset: use MIDI learn"}
                </div>
              )}
            </For>
          </div>
        </div>
        <label>
          <input
            type="checkbox"
            checked={settings.midiInvertTempo}
            onChange={(e) => setSettings("midiInvertTempo", e.currentTarget.checked)}
          />
          Invert the tempo faders
        </label>
        <p class="note">Last message: {lastMessage() || "—"}</p>
        <div class="field">
          <span>MIDI learn</span>
          <input placeholder="Filter actions…" value={filter()} onInput={(e) => setFilter(e.currentTarget.value)} />
        </div>
        <div class="learn-list">
          <For each={ACTIONS.filter((a) => a.label.toLowerCase().includes(filter().toLowerCase()))}>
            {(a) => (
              <div class="learn-row">
                <span>{a.label}</span>
                <span class="mapped">
                  <For each={keyFor(a.id)}>
                    {(k) => (
                      <span class="chip" onClick={() => forget(k)} title="Click to forget">
                        {k.split("|").slice(1).join(" ")} ✕
                      </span>
                    )}
                  </For>
                </span>
                <button classList={{ on: learning() === a.id }} onClick={() => setLearning(learning() === a.id ? null : a.id)}>
                  {learning() === a.id ? "move a control…" : "learn"}
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
