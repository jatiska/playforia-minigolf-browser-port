// Worker thread for scan-hio.mjs. Receives a track filename, runs
// searchHoleInOne with the given (or no) time budget, posts the
// result back to the parent.
//
// One worker handles many tracks sequentially - the scan-hio.mjs
// parent dispatches a new file every time the worker reports done,
// keeping the worker pool busy without per-task spawn overhead.

import { parentPort } from "node:worker_threads";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const aiRoot = resolve(here, "..");
const toUrl = (p) => pathToFileURL(resolve(aiRoot, p)).href;

const { loadTrackHeadless } = await import(toUrl("headless/track-loader.ts"));
const { searchHoleInOne } = await import(toUrl("src/hio.ts"));

parentPort.on("message", async (msg) => {
  if (msg === "exit") {
    process.exit(0);
  }
  const { file, budgetSecs, angleStep, powerStep } = msg;
  const start = Date.now();
  let triedAtTimeout = 0;
  try {
    const track = loadTrackHeadless(file);
    const meta = track.meta;
    const deadline = budgetSecs > 0 ? start + budgetSecs * 1000 : Infinity;
    const hio = await searchHoleInOne(track, {
      angleStep: angleStep ?? 1,
      powerStep: powerStep ?? 2,
      yieldEveryN: 5000,
      isCancelled: () => Date.now() > deadline,
      onProgress: (done) => {
        triedAtTimeout = done;
      },
    });
    const secs = (Date.now() - start) / 1000;
    const base = {
      file,
      name: track.name,
      bestPar: meta?.bestPar ?? -1,
      bestPlayer: meta?.bestPlayer ?? null,
    };
    if (hio) {
      parentPort.postMessage({
        ...base,
        hio: true,
        action: hio.action,
        candidatesTried: hio.candidatesTried,
        secs,
      });
    } else {
      const timedOut = budgetSecs > 0 && Date.now() >= deadline - 50;
      parentPort.postMessage({
        ...base,
        hio: false,
        timed_out: timedOut,
        candidatesTried: triedAtTimeout,
        secs,
      });
    }
  } catch (e) {
    parentPort.postMessage({
      file,
      name: file.replace(/\.track$/i, ""),
      hio: false,
      bestPar: -1,
      bestPlayer: null,
      error: e?.message ?? String(e),
      secs: (Date.now() - start) / 1000,
    });
  }
});
