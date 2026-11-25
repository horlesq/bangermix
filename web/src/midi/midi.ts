// Web MIDI: finds controllers, runs a Mixxx mapping for each (see mixxx/catalog.ts),
// picked by the port's name or by hand, and lets any control be learned.

import { createSignal } from "solid-js";
import { notify } from "../state/app";
import { onFrame } from "../ui/frame";
import { actionById } from "./actions";
import { catalogByFile, matchPort } from "./mixxx/catalog";
import { mixxxPreset } from "./mixxx/preset";
import type { MidiOut, Preset } from "./preset";

/** "auto", "none" or "mixxx:<file>". */
export type Choice = string;

export interface Device {
  id: string;
  name: string;
  preset: string | null;
  choice: Choice;
  status: string;
}

export const [midiDevices, setMidiDevices] = createSignal<Device[]>([]);
export const [midiState, setMidiState] = createSignal<"off" | "on" | "denied" | "unsupported">("off");
/** The action waiting for a control to be moved, in MIDI learn. */
export const [learning, setLearning] = createSignal<string | null>(null);
export const [lastMessage, setLastMessage] = createSignal("");

const LEARN_KEY = "bangermix.midi.learned";
type Learned = Record<string, string>;
export const [learned, setLearnedSig] = createSignal<Learned>(JSON.parse(localStorage.getItem(LEARN_KEY) ?? "{}"));

function setLearned(l: Learned) {
  setLearnedSig(l);
  localStorage.setItem(LEARN_KEY, JSON.stringify(l));
}

export function forget(key: string) {
  const l = { ...learned() };
  delete l[key];
  setLearned(l);
}

const CHOICE_KEY = "bangermix.midi.choice";
const choices: Record<string, Choice> = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? "{}");

interface Running {
  input: MIDIInput;
  output: MIDIOutput | null;
  preset: Preset | null;
  out: MidiOut;
  choice: Choice;
  status: string;
}
const running = new Map<string, Running>();
let access: MIDIAccess | null = null;
let frameHooked = false;

export async function enableMidi() {
  if (!navigator.requestMIDIAccess) {
    setMidiState("unsupported");
    return;
  }
  try {
    access = await navigator.requestMIDIAccess({ sysex: true });
  } catch {
    try {
      access = await navigator.requestMIDIAccess();
    } catch {
      setMidiState("denied");
      return;
    }
  }
  setMidiState("on");
  access.onstatechange = () => refresh();
  refresh();
  if (!frameHooked) {
    frameHooked = true;
    onFrame(() => {
      for (const r of running.values()) r.preset?.frame(r.out);
    });
  }
}

/** Ports carry names like "DDJ-FLX4" or "DDJ-FLX4 MIDI 1"; inputs and outputs pair up by name. */
function baseName(n: string): string {
  return n.replace(/\s*(MIDI\s*)?\d*\s*$/i, "").trim();
}

/** The preset a choice stands for on a port; "auto" picks by the port's name. */
function presetFor(name: string, choice: Choice, status: (s: string) => void): Preset | null {
  if (choice === "none") return null;
  // Anything else unknown (such as an old "builtin:" choice) falls back to automatic.
  const chosen = choice.startsWith("mixxx:") ? catalogByFile.get(choice.slice(6)) : undefined;
  const entry = chosen ?? matchPort(name);
  return entry ? mixxxPreset(entry, status) : null;
}

function publish() {
  setMidiDevices(
    [...running.values()].map((r) => ({
      id: r.input.id,
      name: r.input.name ?? "",
      preset: r.preset?.name ?? null,
      choice: r.choice,
      status: r.status,
    })),
  );
}

function startPreset(r: Running) {
  const name = r.input.name ?? "MIDI device";
  r.status = "";
  r.preset = presetFor(name, r.choice, (s) => {
    r.status = s;
    publish();
  });
  r.preset?.start(r.out);
  if (r.preset) notify(`${name} connected: ${r.preset.name} mapping`);
  else notify(`${name} connected: use MIDI learn in Settings`);
}

function refresh() {
  if (!access) return;
  const outputs = [...access.outputs.values()];
  const seen = new Set<string>();
  for (const input of access.inputs.values()) {
    if (input.state !== "connected") continue;
    seen.add(input.id);
    if (running.has(input.id)) continue;
    const name = input.name ?? "MIDI device";
    const output = outputs.find((o) => o.state === "connected" && baseName(o.name ?? "") === baseName(name)) ?? null;
    const out: MidiOut = (bytes) => {
      try {
        output?.send(bytes);
      } catch {
        /* SysEx not allowed, or the device went away */
      }
    };
    const r: Running = { input, output, preset: null, out, choice: choices[name] ?? "auto", status: "" };
    running.set(input.id, r);
    input.onmidimessage = (e) => onMessage(r, e.data!);
    startPreset(r);
  }
  for (const [id, r] of running) {
    if (!seen.has(id)) {
      r.preset?.stop();
      r.input.onmidimessage = null;
      running.delete(id);
    }
  }
  publish();
}

/** Changes which mapping a device uses (remembered by its port name). */
export function chooseMapping(deviceId: string, choice: Choice) {
  const r = running.get(deviceId);
  if (!r) return;
  const name = r.input.name ?? "";
  if (choice === "auto") delete choices[name];
  else choices[name] = choice;
  localStorage.setItem(CHOICE_KEY, JSON.stringify(choices));
  r.preset?.stop();
  r.choice = choice;
  startPreset(r);
  publish();
}

function hex(n: number) {
  return n.toString(16).toUpperCase().padStart(2, "0");
}

function onMessage(r: Running, data: Uint8Array) {
  if (data.length === 0) return;
  // SysEx and system messages go to the mapping only.
  if (data[0] >= 0xf0) {
    r.preset?.message(data, r.out);
    return;
  }
  if (data.length < 2) return;
  const [status, d1, d2 = 0] = data;
  const kind = status & 0xf0;
  const port = r.input.name ?? "";
  // Note off and note on share a mapping.
  const keyStatus = kind === 0x80 ? status + 0x10 : status;
  const key = `${port}|${hex(keyStatus)}|${hex(d1)}`;
  setLastMessage(`${hex(status)} ${hex(d1)} ${hex(d2)}`);

  const learn = learning();
  if (learn && (kind === 0x90 ? d2 > 0 : kind === 0xb0)) {
    const l = { ...learned() };
    for (const k of Object.keys(l)) if (l[k] === learn && k.startsWith(port)) delete l[k];
    l[key] = learn;
    setLearned(l);
    setLearning(null);
    notify(`Learned: ${actionById.get(learn)?.label}`);
    return;
  }

  const mapped = learned()[key];
  if (mapped) {
    const action = actionById.get(mapped);
    if (!action) return;
    if (kind === 0xb0) action.run(action.kind === "knob" ? d2 / 127 : d2 > 0 ? 1 : 0);
    else if (kind === 0x90 || kind === 0x80) action.run(kind === 0x90 && d2 > 0 ? 1 : 0);
    return;
  }
  r.preset?.message(data, r.out);
}
