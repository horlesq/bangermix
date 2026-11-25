import { For, Show, createResource, createSignal } from "solid-js";
import { outputDevices, type OutputMode } from "../audio/engine";
import { ACTIONS } from "../midi/actions";
import { connectHid, hidDevices, hidSupported } from "../midi/hid";
import {
  chooseMapping,
  enableMidi,
  forget,
  learned,
  learning,
  lastMessage,
  midiDevices,
  midiState,
  setLearning,
} from "../midi/midi";
import { BRANDS, CATALOG, MIXXX_RELEASE } from "../midi/mixxx/catalog";
import { maybeEngine } from "../state/app";
import { type ImportReport, importRekordbox, reanalyse, tracks } from "../state/library";
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
                  {t === "midi" ? "CONTROLLERS" : t.toUpperCase()}
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
    maybeEngine()?.setMode(m, settings.phonesSinkId);
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
          <label>
            <input type="radio" checked={settings.outputMode === "device"} onChange={() => setMode("device")} />
            Separate device for the headphones (e.g. USB headphones or a second sound card)
          </label>
          <Show when={settings.outputMode === "device"}>
            <label class="sub">
              Headphones device
              <select
                value={settings.phonesSinkId}
                onChange={(ev) => {
                  setSettings("phonesSinkId", ev.currentTarget.value);
                  maybeEngine()?.setMode("device", ev.currentTarget.value);
                }}
              >
                <option value="">Choose…</option>
                <For each={devices() ?? []}>
                  {(d, i) => <option value={d.deviceId}>{d.label || `Output ${i() + 1}`}</option>}
                </For>
              </select>
            </label>
          </Show>
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
        <input type="checkbox" checked={settings.syncBars} onChange={(e) => setSettings("syncBars", e.currentTarget.checked)} />
        Sync lines up bars (downbeats land together), not just beats
      </label>
      <label>
        <input type="checkbox" checked={settings.keylockDefault} onChange={(e) => setSettings("keylockDefault", e.currentTarget.checked)} />
        Master tempo (keylock) on when the app starts
      </label>
      <label>
        Waveforms
        <select value={settings.waveformStyle} onChange={(e) => setSettings("waveformStyle", e.currentTarget.value as "rgb")}>
          <option value="rgb">RGB (colour by frequency)</option>
          <option value="3band">3-band</option>
        </select>
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
  const [report, setReport] = createSignal<ImportReport | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let input!: HTMLInputElement;
  const importFile = async (file: File) => {
    setBusy(true);
    setError("");
    setReport(null);
    try {
      setReport(await importRekordbox(await file.text()));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="form">
      <div class="field">
        <span>rekordbox</span>
        <div>
          <button disabled={busy()} onClick={() => input.click()}>
            {busy() ? "IMPORTING…" : "IMPORT REKORDBOX.XML"}
          </button>
          <input
            ref={input}
            type="file"
            accept=".xml"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) void importFile(f);
              e.currentTarget.value = "";
            }}
          />
        </div>
      </div>
      <p class="note">
        In rekordbox: File → Export Collection in xml format. Beat grids, keys, hot cues, memory cues, loops, ratings and
        playlists come across. Add the music folders here first: tracks are matched by file name and size.
      </p>
      <Show when={error()}>
        <p class="note warn">{error()}</p>
      </Show>
      <Show when={report()}>
        <p class="note">
          Matched {report()!.matched} of {report()!.inXml} tracks, {report()!.playlists} playlists.
          <Show when={report()!.missingCount > 0}>
            {" "}
            Not in the library ({report()!.missingCount}): {report()!.missing.join(", ")}
            {report()!.missingCount > report()!.missing.length ? "…" : ""}
          </Show>
        </p>
      </Show>
      <hr />
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
          <span>MIDI devices</span>
          <div class="devices">
            <Show when={midiDevices().length === 0}>
              <em>None connected.</em>
            </Show>
            <For each={midiDevices()}>
              {(d) => (
                <div class="device">
                  <div class="device-name">{d.name}</div>
                  <select value={d.choice} onChange={(e) => chooseMapping(d.id, e.currentTarget.value)}>
                    <option value="auto">Automatic{d.choice === "auto" && d.preset ? ` (${d.preset})` : ""}</option>
                    <option value="none">None (MIDI learn only)</option>
                    <For each={BRANDS}>
                      {(b) => (
                        <optgroup label={b}>
                          <For each={CATALOG.filter((c) => c.brand === b && !c.hid)}>
                            {(c) => <option value={`mixxx:${c.file}`}>{c.model}</option>}
                          </For>
                        </optgroup>
                      )}
                    </For>
                  </select>
                  <Show when={d.status}>
                    <div class="note">{d.status}</div>
                  </Show>
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
      <hr />
      <div class="field">
        <span>HID controllers</span>
        <div class="devices">
          <Show
            when={hidSupported}
            fallback={<em>This browser has no WebHID. Use Chrome or Edge.</em>}
          >
            <For each={hidDevices()}>
              {(d) => (
                <div class="device">
                  <div class="device-name">{d.name}</div>
                  <div class="note">{d.status}</div>
                </div>
              )}
            </For>
            <button onClick={() => void connectHid()}>Connect a HID controller…</button>
            <p class="note">Most Traktor Kontrol controllers, and Pioneer CDJs in HID mode. Chrome asks once.</p>
          </Show>
        </div>
      </div>
      <SupportedControllers />
    </div>
  );
}

function SupportedControllers() {
  return (
    <details class="supported">
      <summary>Supported controllers</summary>
      <p class="note">
        Mixxx project mappings (release {MIXXX_RELEASE}) are fetched from GitHub the first time a controller is used,
        then work offline. They are tested by the Mixxx community on Mixxx; here they run through a compatibility layer
        and are untested on hardware. Features this app lacks (samplers, stems, more than one effect at a time) do nothing.
      </p>
      <For each={BRANDS}>
        {(b) => (
          <div class="brand-list">
            <strong>{b}</strong>
            <span>
              {CATALOG.filter((c) => c.brand === b)
                .map((c) => `${c.model}${c.hid ? " (HID)" : ""}`)
                .join(" · ")}
            </span>
          </div>
        )}
      </For>
    </details>
  );
}
