// The beat FX unit: effect, beat length, channel, level, parameter, on.

import { For } from "solid-js";
import { FX, FX_TARGET_MASTER } from "../audio/params";
import { masterDeck } from "../state/deck";
import { mixer, setFx } from "../state/mixer";
import { settings } from "../state/settings";
import { HoldButton, Knob } from "./controls";

const EFFECTS = [
  { id: FX.ECHO, name: "Echo", param: "Feedback" },
  { id: FX.REVERB, name: "Reverb", param: "Size" },
  { id: FX.FLANGER, name: "Flanger", param: "Feedback" },
  { id: FX.ROLL, name: "Roll", param: "—" },
];
const BEATS = [1 / 8, 1 / 4, 1 / 2, 3 / 4, 1, 2, 4];

function beatLabel(b: number): string {
  if (b >= 1) return String(b);
  return { 0.125: "1/8", 0.25: "1/4", 0.5: "1/2", 0.75: "3/4" }[b] ?? b.toFixed(2);
}

export function FxPanel() {
  const fx = () => mixer.fx;
  const effect = () => EFFECTS.find((e) => e.id === fx().type) ?? EFFECTS[0];
  const targets = () => [...Array(settings.deckCount).keys(), FX_TARGET_MASTER];
  return (
    <div class="fx">
      <span class="fx-label">BEAT FX</span>
      <select value={fx().type} onChange={(e) => setFx("type", Number(e.currentTarget.value))}>
        <For each={EFFECTS}>{(e) => <option value={e.id}>{e.name}</option>}</For>
      </select>
      <div class="seg">
        <For each={BEATS}>
          {(b) => (
            <button classList={{ on: fx().beats === b }} onClick={() => setFx("beats", b)}>
              {beatLabel(b)}
            </button>
          )}
        </For>
      </div>
      <div class="seg">
        <For each={targets()}>
          {(t) => (
            <button classList={{ on: fx().target === t }} onClick={() => setFx("target", t)} title="Which channel the effect is on">
              {t === FX_TARGET_MASTER ? "MST" : t + 1}
            </button>
          )}
        </For>
      </div>
      <Knob label="LEVEL" value={fx().wet} reset={0.6} size={28} onChange={(v) => setFx("wet", v)} />
      <Knob label={effect().param.toUpperCase()} value={fx().param} reset={0.5} size={28} onChange={(v) => setFx("param", v)} />
      <button class="fx-on" classList={{ on: fx().on }} onClick={() => setFx("on", !fx().on)} title="Effect on/off (click)">
        ON
      </button>
      <HoldButton class="fx-hold" onDown={() => setFx("on", true)} onUp={() => setFx("on", false)} title="Effect while held">
        HOLD
      </HoldButton>
      <span class="fx-bpm">{(masterDeck()?.currentBpm() || 120).toFixed(1)} BPM</span>
    </div>
  );
}
