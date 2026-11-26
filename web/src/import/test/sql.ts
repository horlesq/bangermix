/// <reference types="node" />
// sql.js for tests: its wasm read from node_modules and handed over as bytes (the app
// loads it by URL instead).
import initSqlJs from "sql.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const wasm = () => readFileSync(fileURLToPath(new URL("../../../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url)));

export const testSqlite = () => initSqlJs({ wasmBinary: wasm() as unknown as ArrayBuffer });
