// research_eval.ts - the eval entry point.
//
// Per AUTORESEARCH_PLAN.md §4:
//   "A new script - call it research_eval.ts - that:
//     1. Loads a fixed set of N maps.
//     2. For each map: train fresh, eval, record success rate.
//     3. Average success rate across maps. EMITS ONE NUMBER.
//     4. Appends a row to research_log.jsonl."
//
// Per §6 we run **3 seeds and take the median** for noise control.
// The harness reports per-seed scores; this file does the median.
//
// Usage:
//   node --experimental-strip-types port/ai/research_eval.ts [--mode eval|validate|smoke] [--budget short|default|long]
//
//   - eval:     16-map eval set, 60s × 16 × 3 seeds = ~48 min wall.
//   - validate: 40-map held-out set, same budget structure → ~2 hours.
//   - smoke:    1 map, 1 seed, 5s budget. For "is the harness wired up at all".
//
// Output:
//   - stdout: ONE NUMBER (the score). Other diagnostics go to stderr.
//   - research_log.jsonl: one JSON line appended per invocation.
//
// The "one number to stdout" pattern is so the autoresearch loop runner
// can `cat $(node ... | tail -1)` and parse the score without bespoke
// machinery. Anything more interesting goes through the JSONL.

import { writeFileSync, appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { TRAINING_CONFIG, NOTES } from "./research_program.ts";
import { runHarness, type HarnessResult } from "./headless/harness.ts";
import { EVAL_MAPS, VALIDATION_MAPS } from "./headless/maps.ts";
import {
  clampToAutoresearchBounds,
  AUTORESEARCH_BOUNDS,
} from "./headless/autoresearch-bounds.ts";

const here = dirname(fileURLToPath(import.meta.url));

const LOG_PATH = resolve(here, "research_log.jsonl");
const VALIDATION_LOG_PATH = resolve(here, "research_validation_log.jsonl");

interface CliArgs {
  mode: "eval" | "validate" | "smoke";
  budget: "short" | "default" | "long";
  /** Optional: tag to attach to this row. Useful for experiment tracking
   *  ("baseline", "smoke", "manual-test", etc). */
  tag: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { mode: "eval", budget: "default", tag: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--mode") args.mode = argv[++i] as CliArgs["mode"];
    else if (a === "--budget") args.budget = argv[++i] as CliArgs["budget"];
    else if (a === "--tag") args.tag = argv[++i];
  }
  return args;
}

function budgetFor(mode: CliArgs["mode"], budget: CliArgs["budget"]) {
  // Smoke: short and self-evidently correct - 1 map, 1 seed, 5s.
  if (mode === "smoke") {
    return { trainSecsPerMap: 5, evalEpisodesPerMap: 8, seeds: [42] };
  }
  // Eval / validate. Three pre-set budgets so the loop can request
  // "short" (early calibration) without re-thinking the formula.
  switch (budget) {
    case "short":
      return { trainSecsPerMap: 15, evalEpisodesPerMap: 16, seeds: [42, 123, 7] };
    case "long":
      return { trainSecsPerMap: 120, evalEpisodesPerMap: 32, seeds: [42, 123, 7] };
    case "default":
    default:
      return { trainSecsPerMap: 60, evalEpisodesPerMap: 24, seeds: [42, 123, 7] };
  }
}

/** Hash the config so the JSONL log can dedup identical re-runs. */
function configHash(cfg: typeof TRAINING_CONFIG): string {
  const ordered = Object.keys(cfg)
    .sort()
    .map((k) => `${k}=${(cfg as any)[k]}`)
    .join("|");
  return createHash("sha256").update(ordered).digest("hex").slice(0, 12);
}

/** Group a HarnessResult's per-map data by seed, then return the
 *  median-by-seed score. The harness's own `score` field is a flat mean
 *  - useful for diagnostics, but the loop wants the median across seeds
 *  to be robust to one bad seed. */
function medianBySeed(result: HarnessResult): number {
  const bySeed = new Map<number, number[]>();
  for (const m of result.perMap) {
    const ratio = m.holedCount / m.evalEpisodes;
    if (!bySeed.has(m.seed)) bySeed.set(m.seed, []);
    bySeed.get(m.seed)!.push(ratio);
  }
  const seedScores = [...bySeed.values()].map(
    (rs) => rs.reduce((a, b) => a + b, 0) / rs.length,
  );
  seedScores.sort((a, b) => a - b);
  const mid = Math.floor(seedScores.length / 2);
  return seedScores.length % 2 === 0
    ? (seedScores[mid - 1] + seedScores[mid]) / 2
    : seedScores[mid];
}

/** Read the JSONL log, return prior best score (or -Infinity if none). */
function priorBest(logPath: string): number {
  if (!existsSync(logPath)) return -Infinity;
  const lines = readFileSync(logPath, "utf8").trim().split(/\r?\n/);
  let best = -Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.score === "number" && r.score > best) best = r.score;
    } catch {
      // ignore
    }
  }
  return best;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();

  // Apply the autoresearch bounds. If the program tried to set
  // something outside the allowed range, we record both the requested
  // and the clamped value so the human can see the difference.
  const requestedCfg = { ...TRAINING_CONFIG };
  const clampedCfg = clampToAutoresearchBounds(requestedCfg);
  const wasClamped = JSON.stringify(requestedCfg) !== JSON.stringify(clampedCfg);

  const mapList = args.mode === "validate" ? VALIDATION_MAPS : EVAL_MAPS;
  const maps =
    args.mode === "smoke" ? ["CurveI.track"] : mapList.map((m) => m.file);

  const budget = budgetFor(args.mode, args.budget);

  process.stderr.write(
    `[research_eval] mode=${args.mode} budget=${args.budget} ` +
      `maps=${maps.length} trainSecs=${budget.trainSecsPerMap} ` +
      `evalEps=${budget.evalEpisodesPerMap} seeds=${budget.seeds.join(",")}\n`,
  );
  if (wasClamped) {
    process.stderr.write(`[research_eval] WARNING: config was clamped to bounds\n`);
  }

  const result = await runHarness({
    cfg: clampedCfg,
    maps,
    trainSecsPerMap: budget.trainSecsPerMap,
    evalEpisodesPerMap: budget.evalEpisodesPerMap,
    seeds: budget.seeds,
    onProgress: ({ map, seed, phase, pct }) => {
      // One progress line per map/seed/phase transition (don't spam).
      // The runner can grep these to show liveness.
      if (pct === 1.0 || (phase === "train" && pct >= 0.5 && pct < 0.55)) {
        process.stderr.write(
          `  ${map} seed=${seed} ${phase} ${(pct * 100).toFixed(0)}%\n`,
        );
      }
    },
  });

  const score = medianBySeed(result);
  const meanScore = result.score;
  const prior = priorBest(args.mode === "validate" ? VALIDATION_LOG_PATH : LOG_PATH);

  // Per-map summary for the JSONL. Aggregate across seeds.
  const perMapSummary = new Map<
    string,
    { holed: number; total: number; meanStrokesOnHoled: number; hioWonAny: boolean }
  >();
  for (const m of result.perMap) {
    const cur = perMapSummary.get(m.map) ?? {
      holed: 0,
      total: 0,
      meanStrokesOnHoled: 0,
      hioWonAny: false,
    };
    cur.holed += m.holedCount;
    cur.total += m.evalEpisodes;
    if (Number.isFinite(m.meanStrokesOnHoled)) {
      cur.meanStrokesOnHoled =
        (cur.meanStrokesOnHoled * (cur.total - m.evalEpisodes) +
          m.meanStrokesOnHoled * m.holedCount) /
        Math.max(1, cur.total);
    }
    if (m.hioWon) cur.hioWonAny = true;
    perMapSummary.set(m.map, cur);
  }

  const row = {
    timestamp: startedAt,
    mode: args.mode,
    budget: args.budget,
    tag: args.tag,
    score, // PRIMARY: median-by-seed mean-across-maps success rate
    score_mean: meanScore, // backup: flat mean across all (map, seed) trials
    prev_best: prior,
    kept: score > prior, // strict-better-or-revert per §6
    wall_secs: (Date.now() - wallStart) / 1000,
    map_count: maps.length,
    train_secs_per_map: budget.trainSecsPerMap,
    eval_episodes_per_map: budget.evalEpisodesPerMap,
    seeds: budget.seeds,
    config_hash: configHash(clampedCfg),
    config: clampedCfg,
    config_was_clamped: wasClamped,
    requested_config: wasClamped ? requestedCfg : null,
    notes: NOTES.replace(/\s+/g, " ").trim().slice(0, 500),
    per_map: Object.fromEntries(
      [...perMapSummary.entries()].map(([k, v]) => [
        k,
        {
          success_rate: v.holed / v.total,
          mean_strokes_on_holed: Number.isFinite(v.meanStrokesOnHoled)
            ? Number(v.meanStrokesOnHoled.toFixed(2))
            : null,
          hio_won_any_seed: v.hioWonAny,
        },
      ]),
    ),
  };

  const logPath = args.mode === "validate" ? VALIDATION_LOG_PATH : LOG_PATH;
  appendFileSync(logPath, JSON.stringify(row) + "\n");

  process.stderr.write(
    `[research_eval] done: score=${score.toFixed(4)} ` +
      `(prev best=${prior === -Infinity ? "none" : prior.toFixed(4)}, ` +
      `kept=${row.kept}, wall=${row.wall_secs.toFixed(1)}s)\n`,
  );

  // PRIMARY OUTPUT - last line on stdout is the score, parsable by the loop.
  process.stdout.write(score.toFixed(6) + "\n");
}

main().catch((e) => {
  process.stderr.write(`[research_eval] FATAL: ${e?.stack ?? e}\n`);
  process.exit(1);
});
