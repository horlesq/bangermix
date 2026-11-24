// A pool of decoder workers. Deck loads ("high" priority) jump the queue, and the
// first worker is kept free for them, so loading a track never waits behind a whole
// library being analysed.

import type { JobRequest, JobResult } from "./protocol";

type Priority = "high" | "low";

interface Job {
  req: JobRequest;
  priority: Priority;
  resolve: (r: JobResult) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  busy: boolean;
  /** Only takes high-priority jobs. */
  reserved: boolean;
}

let nextId = 1;

export class WorkerPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private waiting = new Map<number, { job: Job; slot: Slot }>();

  constructor(size = defaultSize()) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(new URL("./decoder.worker.ts", import.meta.url), { type: "module" });
      const slot: Slot = { worker, busy: false, reserved: i === 0 && size > 1 };
      worker.onmessage = (e) => this.done(e.data);
      this.slots.push(slot);
    }
  }

  run(req: JobRequest, priority: Priority = "low"): Promise<JobResult> {
    return new Promise((resolve, reject) => {
      const job = { req, priority, resolve, reject };
      if (priority === "high") {
        const firstLow = this.queue.findIndex((j) => j.priority === "low");
        this.queue.splice(firstLow < 0 ? this.queue.length : firstLow, 0, job);
      } else {
        this.queue.push(job);
      }
      this.pump();
    });
  }

  /** Jobs not started yet. */
  get queued(): number {
    return this.queue.length;
  }

  /** Drops the low-priority jobs not started yet. */
  cancelLow() {
    const dropped = this.queue.filter((j) => j.priority === "low");
    this.queue = this.queue.filter((j) => j.priority === "high");
    for (const j of dropped) j.reject(new Error("cancelled"));
  }

  private pump() {
    for (const slot of this.slots) {
      if (slot.busy) continue;
      const i = this.queue.findIndex((j) => !slot.reserved || j.priority === "high");
      if (i < 0) continue;
      const [job] = this.queue.splice(i, 1);
      const id = nextId++;
      slot.busy = true;
      this.waiting.set(id, { job, slot });
      slot.worker.postMessage({ ...job.req, id }, [job.req.bytes]);
    }
  }

  private done(msg: { id: number; result?: JobResult; error?: string }) {
    const w = this.waiting.get(msg.id);
    if (!w) return;
    this.waiting.delete(msg.id);
    w.slot.busy = false;
    if (msg.error !== undefined) w.job.reject(new Error(msg.error));
    else w.job.resolve(msg.result!);
    this.pump();
  }
}

function defaultSize(): number {
  // Each worker holds a decoded track while it works; keep memory in check.
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(2, Math.min(4, cores - 2));
}
