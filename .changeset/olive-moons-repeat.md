---
'roboport': patch
---

Resolve `claudeCode` file-tool paths against the session `cwd`. `Read`, `Edit`, and `Write` passed `file_path` straight to the filesystem, so a relative path resolved against `process.cwd()` and escaped the directory the session was scoped to — the `pi` harness already resolved against `ctx.cwd`. Their schemas demanded absolute paths, which masked the bug with models that reliably send them; models that send `./note.txt` wrote to the wrong directory. Absolute paths are unaffected.
