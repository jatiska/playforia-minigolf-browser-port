// Scan every track in port/server/tracks/tracks/ for a hole-in-one
// solution. Saves the results to port/ai/hio-scan.json so the
// browser /hio.html page can render the list without re-scanning.
//
// HIO is a brute-force shot search; on a non-HIO-able map it exhausts
// the full polar grid (~35,000 shots × ~25ms each ≈ 15 min of CPU per
// map). Across 2062 tracks that's hours, most of it spent confirming
// no-HIO. We cap each search at a per-map time budget instead — if no
// HIO is found in `--budget-secs` seconds, the track is recorded as
// "no HIO at this budget" with how many candidates were tried.
//
// Usage:
//   node --experimental-strip-types scripts/scan-hio.mjs [--budget-secs N]
//
// Defaults:
//   --budget-secs 4   per-map time budget; HIO maps usually complete
//                     in well under this (early termination on first hit).
//
// Output: port/ai/hio-scan.json
//   {
//     scanned_at, total, completed, hio_count, err_count, elapsed_secs,
//     budget_secs, tracks: [
//       { file, name, hio: bool, action?: {dx, dy}, candidatesTried,
//         secs, timed_out?: bool, error?: string }, ...
//     ]
//   }

import { readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const aiRoot = resolve(here, "..");
const tracksDir = resolve(aiRoot, "../server/tracks/tracks");
const outPath = resolve(aiRoot, "hio-scan.json");

const toUrl = (p) => pathToFileURL(resolve(aiRoot, p)).href;
const { loadTrackHeadless } = await import(toUrl("headless/track-loader.ts"));
const { searchHoleInOne } = await import(toUrl("src/hio.ts"));

// Parse --budget-secs from argv.
const argv = process.argv.slice(2);
let budgetSecs = 4;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--budget-secs") budgetSecs = Number(argv[++i]);
}
console.error(`[scan-hio] per-map budget: ${budgetSecs}s`);

const files = readdirSync(tracksDir)
  .filter((f) => f.endsWith(".track"))
  .sort();

console.error(`[scan-hio] scanning ${files.length} tracks ...`);
const t0 = Date.now();
const results = [];
let hioCount = 0;
let errCount = 0;
let timeoutCount = 0;

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const start = Date.now();
  let triedAtTimeout = 0;
  try {
    const track = loadTrackHeadless(file);
    // Wrap the search in a per-map deadline. searchHoleInOne polls
    // isCancelled() at every yield point (every yieldEveryN=2000
    // candidates here), so the cancellation latency is bounded by how
    // long 2000 candidates take (typically <1s).
    const deadline = start + budgetSecs * 1000;
    const hio = await searchHoleInOne(track, {
      yieldEveryN: 2000,
      isCancelled: () => Date.now() > deadline,
      onProgress: (done) => { triedAtTimeout = done; },
    });
    const secs = (Date.now() - start) / 1000;
    if (hio) {
      hioCount++;
      results.push({
        file,
        name: track.name,
        hio: true,
        action: hio.action,
        candidatesTried: hio.candidatesTried,
        secs,
      });
    } else {
      // Distinguish "search exhausted, no HIO exists" from "ran out
      // of time": if we cancelled because of the deadline, mark as
      // timed_out=true so the dashboard can show "no HIO found within
      // budget" rather than the stronger "no HIO exists."
      const timedOut = Date.now() >= deadline - 50;
      if (timedOut) timeoutCount++;
      results.push({
        file,
        name: track.name,
        hio: false,
        timed_out: timedOut,
        candidatesTried: triedAtTimeout,
        secs,
      });
    }
  } catch (e) {
    errCount++;
    results.push({
      file,
      name: file.replace(/\.track$/i, ""),
      hio: false,
      error: e?.message ?? String(e),
      secs: (Date.now() - start) / 1000,
    });
  }

  if ((i + 1) % 25 === 0 || i === files.length - 1) {
    const elapsed = (Date.now() - t0) / 1000;
    const eta = (elapsed / (i + 1)) * (files.length - i - 1);
    process.stderr.write(
      `  ${i + 1}/${files.length}  hio=${hioCount}  timeout=${timeoutCount}  err=${errCount}  ` +
        `elapsed=${elapsed.toFixed(0)}s  eta=${eta.toFixed(0)}s\n`,
    );
    // Save partial progress on every checkpoint so we don't lose the
    // results if the process is interrupted.
    writeFileSync(
      outPath,
      JSON.stringify(
        {
          scanned_at: new Date().toISOString(),
          total: files.length,
          completed: i + 1,
          hio_count: hioCount,
          err_count: errCount,
          timeout_count: timeoutCount,
          budget_secs: budgetSecs,
          elapsed_secs: elapsed,
          tracks: results,
        },
        null,
        2,
      ),
    );
  }
}

const elapsed = (Date.now() - t0) / 1000;
console.error(
  `[scan-hio] done: ${hioCount}/${files.length} HIO, ${timeoutCount} timed out, ${errCount} errors, ${elapsed.toFixed(0)}s wall`,
);
console.error(`[scan-hio] wrote ${outPath}`);
