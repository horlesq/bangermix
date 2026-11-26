// sql.js (SQLite in WebAssembly), loaded the first time something needs it: the Engine
// DJ export, and imports from Engine DJ and Mixxx.

import type { SqlJsStatic } from "sql.js";

let sqlJs: Promise<SqlJsStatic> | null = null;

export function sqlite(): Promise<SqlJsStatic> {
  sqlJs ??= Promise.all([import("sql.js"), import("sql.js/dist/sql-wasm.wasm?url")]).then(([m, wasm]) =>
    m.default({ locateFile: () => wasm.default }),
  );
  return sqlJs;
}
