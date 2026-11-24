// Records the master output to a file (WebM/Opus, 256 kbps), saved when stopped.

import type { AudioEngine } from "./engine";
import { settings } from "../state/settings";

export interface Recording {
  stop(): Promise<void>;
  startedAt: number;
}

export function startRecording(e: AudioEngine): Recording {
  const ctx = e.ctx;
  const split = ctx.createChannelSplitter(4);
  const merge = ctx.createChannelMerger(2);
  e.node.connect(split);
  // In split mode output 1 is the master in mono and output 2 the headphones.
  const right = settings.outputMode === "split" ? 0 : 1;
  split.connect(merge, 0, 0);
  split.connect(merge, right, 1);
  const dest = ctx.createMediaStreamDestination();
  merge.connect(dest);
  const type = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
  const rec = new MediaRecorder(dest.stream, { mimeType: type || undefined, audioBitsPerSecond: 256_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
  rec.start(1000);
  const startedAt = Date.now();
  return {
    startedAt,
    stop: () =>
      new Promise<void>((resolve) => {
        rec.onstop = () => {
          e.node.disconnect(split);
          const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
          const a = document.createElement("a");
          const stamp = new Date(startedAt).toISOString().slice(0, 16).replace(/[:T]/g, "-");
          a.href = URL.createObjectURL(blob);
          a.download = `bangermix-${stamp}.webm`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
          resolve();
        };
        rec.stop();
      }),
  };
}
