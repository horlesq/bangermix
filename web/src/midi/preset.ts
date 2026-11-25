// What runs a MIDI controller: turns its messages into actions and lights its LEDs.
// The one implementation is a Mixxx mapping (mixxx/preset.ts).

export type MidiOut = (bytes: number[]) => void;

export interface Preset {
  name: string;
  start(out: MidiOut): void;
  stop(): void;
  message(data: Uint8Array, out: MidiOut): void;
  /** Called every animation frame, for LEDs and meters. */
  frame(out: MidiOut): void;
}
