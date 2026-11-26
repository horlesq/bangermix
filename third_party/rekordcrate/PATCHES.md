# rekordcrate, vendored

Source: https://github.com/Holzhaus/rekordcrate at commit
`82a6077bda95b072186aa551af27e2135217a30d` (main, November 2026). Its device-export
writer is not on crates.io yet. Licensed under the Mozilla Public License 2.0 (`COPYING`);
these files stay under it.

Changes from upstream:

- `src/device/export.rs`: added `DeviceExport::save_to_memory`, which returns the files
  `save` would write instead of writing them, for WebAssembly in a browser.
- `src/device/export.rs`: added `DeviceExport::open_from_memory` (open an export from the
  bytes of its databases) and `DeviceExport::analysis_paths` (each track's stored analysis
  file path), for importing a USB stick in a browser.
- Left out: the command-line tool (`src/main.rs`), the test suites that need the upstream
  test data (`src/pdb/test_roundtrip.rs`, `src/pdb/test_modification.rs`, `tests/`,
  `data/`) and the build script that generates tests from that data. `Cargo.toml` is
  trimmed to match (no CLI dependencies; the library's own tests are not built).
