# `t.file()` — large binary inputs as streams, uploads stored in files — spike S20 (2026-10-28)

Question (from you, after the upload-storage options A/B): is option B, a dedicated streaming type,
the right answer? A short spike to find out what it costs and what it changes.

## What was built

- **`t.file({ max? })`**: a schema type for *inputs only* (`op()` rejects it in outputs and in
  client/bidi streams: it travels as an upload reference, which needs a unary input). Handlers get a
  `FileValue { size, sha256, stream() }` — never the whole content. Clients pass a `Blob`, a
  `Uint8Array` or an `UploadRef`. JSON Schema: `{"type":"string","contentMediaType":
  "application/octet-stream","x-apue-transfer":"upload","x-apue-max-size":n}`; codegen maps it back
  to `t.file({max})` (round trip intact).
- **On the wire nothing new**: the same `/$uploads` resource and `{"$upload": id}` reference as
  `t.bytes()` inputs (S18). `t.file()` only changes what the handler receives (a stream instead of a
  buffer) and what the client accepts (`Blob`, sent without ever being read into memory; a resume
  sends `blob.slice(offset)`).
- **`uploads.directory`** (server option): upload content goes to files in a per-process
  subdirectory (`mkdtemp`, removed on `close()`), written in 1 MiB blocks; `t.file()` handlers read
  them with `createReadStream`, `t.bytes()` handlers get a fresh buffer read from the file. Without
  the option everything stays in memory as before (and `t.file()` streams copies of the stored
  chunks).
- Upload limits are now validated (positive safe integers): the probe's own `2 << 30` (a negative
  number in JavaScript) had silently configured a store that refuses everything.

## Measured (512 MiB through a separate server process, HTTP/2, one machine)

| server | content in | end to end | server RSS (before → peak) | client peak RSS |
|---|---|---|---|---|
| `t.file()`, `directory` | files | 380–463 MiB/s | 85 → 255–267 MiB | 141–143 MiB |
| `t.file()`, memory | memory | 293–432 MiB/s (110 cold) | 108 → 723–748 MiB | 134–140 MiB |
| `t.bytes()`, memory | memory | 196–283 MiB/s | 747 → 1,104–1,764 MiB | 1,069–1,090 MiB |

- **Memory is bounded with `directory`, independent of size**: 128 MiB → peak 223 MiB, 1 GiB →
  268–280 MiB on the same server (client ≈ 140 MiB in both). With memory storage the server holds
  the whole upload; with `t.bytes()` both sides hold it (the client needs a `Uint8Array`).
- Phases (`directory`): upload alone 0.83 s (618 MiB/s), the handler streaming and hashing it
  0.37 s (1,373 MiB/s).
- **The first file-mode numbers were wrong by 10×**: 46–51 MiB/s (upload phase 48 MiB/s) — measured
  while the disk was full (818 MiB free on the data volume; a raw-write benchmark gave an
  inconsistent 81–285 MiB/s). Coalescing writes into 1 MiB blocks didn't change it then, so it was
  not the per-chunk write count. Re-measured with 7.7 GiB free: the numbers above. Kept the
  coalescing anyway (one write per 16 KiB HTTP/2 chunk is a thread-pool round trip each).
- Noise: load average 6–14 during the runs (system daemons); runs vary ±25 %, the first run of a
  fresh server is slower (cold). Throughput comparisons between rows are indicative only; the
  memory columns are the result.

## Bugs found by the spike (fixed, with tests that fail without the fix)

1. **A refused upload could hang the connection and `server.close()` forever** (found as an
   intermittent full-suite hang, 2 of 24 loaded runs of the upload tests). When an append was
   refused before its content was complete (store full 503, too large 413), the request body's
   iterator was abandoned with its `'readable'` listener still attached; Node's `resume()` "has no
   effect if there is a 'readable' event listener", so the unread rest was never drained, the stream
   never ended, and neither did the connection's session or `server.close()`. Located by tagging
   every socket with its creation stack and dumping the survivors; a plain `node:http2` repro with
   the same server options did *not* hang (12/12), because `for await` releases the iterator — the
   upload loop drives it by hand. Fix: release the iterator however the loop ends. The test fails
   3/3 without the fix; after it, 0 of 24 loaded runs hung. (Since S18; not caused by `t.file()`.)
2. **Handlers could change a stored upload in memory mode**: `stream()` yielded the stored chunks
   themselves, so a handler writing into one changed the content for later calls and replays
   (the same class of bug as S18's shared `t.bytes()` buffer). Now it yields copies.
3. Tests leaked temp directories (3,185 `apue-*` directories, ≈ 500 MiB, had accumulated in the
   system temp dir — 2,788 of them certificates): the cert helper, codegen and file tests now remove
   theirs; a full run leaves none.

## Limits of the spike (not done)

- **Uploads don't survive a restart** (by design here: the subdirectory is per process). A crashed
  process leaves its subdirectory behind (`apue-uploads-*`); nothing sweeps it — a sweep at startup
  is unsafe when several processes share the directory. Operators clear it, or use a directory per
  instance.
- **An upload deleted while a handler streams it** (its owner's `DELETE`, or expiry): in file mode
  the stream fails (`ENOENT` if not yet opened) and the call errors; memory mode keeps the chunks
  alive. The client only deletes after its call has settled, so only a second party or a TTL shorter
  than the call can trigger it.
- **`Upload-Offset` may count bytes not yet written** (up to 1 MiB buffered per upload). If the
  write then fails, the upload is deleted (507) rather than resumed with a hole; the client must
  start over.
- No browser test for `t.file()` with a `Blob` yet (the browser upload tests use `Uint8Array`; the
  `Blob` path is fetch with a `Blob` body, which browsers send without streaming).
- Not measured over a real network or with several concurrent uploads.
- `server.close()` still waits without a limit for in-flight streams, and the idle timeout only
  calls `session.close()` (a no-op on a session that is already closing). Bug 1 showed how that turns
  any stuck stream into a hang; a close deadline that destroys what is left would bound it.

## Assessment

- B holds up: the API change is one schema type, the wire is unchanged, and it is the only option
  that bounds memory on *both* sides (A, file storage alone, bounds the server but handlers and
  clients still hold the whole buffer — the `t.bytes()` row).
- `t.file()` without `directory` still saves the client (Blob, no buffer) and is no slower; with
  `directory` the server's memory no longer depends on upload size.
- Throughput with `directory` depends on the disk (the full-disk episode: 10× slower), which the
  memory store doesn't — documenting that is part of the option.
