// Builds the two WebAssembly modules and copies them where the web app serves them.
import { execSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execSync(
  "cargo build --release --target wasm32-unknown-unknown -p bm-engine-wasm -p bm-worker-wasm",
  { cwd: root, stdio: "inherit" },
);
const from = join(root, "target", "wasm32-unknown-unknown", "release");
const to = join(root, "web", "public", "wasm");
mkdirSync(to, { recursive: true });
copyFileSync(join(from, "bm_engine_wasm.wasm"), join(to, "engine.wasm"));
copyFileSync(join(from, "bm_worker_wasm.wasm"), join(to, "worker.wasm"));
console.log("wasm -> web/public/wasm");
