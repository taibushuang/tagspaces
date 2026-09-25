# Everything integration binaries

Source:
- https://www.voidtools.com/ES-1.1.0.38.x64.zip (voidtools ES — the official
  Everything command-line interface; freeware, redistributable per voidtools)

The voidtools installer does NOT ship a helper binary, so we bundle es.exe.
Everything.exe itself must be installed (or will be auto-started).

The Everything search integration uses es.exe: it spawns es.exe, which talks to
the running Everything client over IPC and writes UTF-8 TSV to a temp file.

es.exe   — 64-bit CLI client for Everything (used by the search)