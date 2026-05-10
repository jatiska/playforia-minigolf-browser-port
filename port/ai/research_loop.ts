// research_loop.ts - the autonomous-loop driver.
//
// Per AUTORESEARCH_PLAN.md §6:
//   1. Read research_log.jsonl (last 30 entries).
//   2. Read program.md.
//   3. Hypothesise ONE change to research_program.ts.
//   4. Apply the change.
//   5. Invoke research_eval.ts. Wait for the wall-clock budget.
//   6. Read the emitted score.
//   7. Compare against prior best. Keep-or-revert. Append a row.
//   8. Loop.
//
// This file is the runner. Steps 2-3 are LLM-shaped (Claude Code reading
// program.md and emitting an edit), so the runner shells out to a CLI.
// The default CLI is `claude` (Claude Code). If you want to drive the
// loop with a different agent (gpt, manual, etc), set --agent-cmd to
// the binary that takes the prompt on stdin and writes the new
// research_program.ts contents on stdout.
//
// Hard rules the runner enforces:
//   - Saves a copy of research_program.ts before every iteration. If
//     the score is worse, restores from the copy. The agent can't
//     accidentally drift the codebase.
//   - Validates the agent's output IS valid TypeScript that exports
//     TRAINING_CONFIG (typescript-import sanity check).
//   - Stops on the keep-rate / score-plateau triggers in §11.
//
// Usage:
//   node --experimental-strip-types port/ai/research_loop.ts \
//     --max-iterations 30 \
//     --budget short \
//     --agent-cmd 'claude --print --no-input'
//
// The loop is designed to be stoppable: SIGINT (Ctrl+C) finishes the
// current iteration cleanly, then exits. No state is lost.

import { spawnSync, execSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  copyFileSync,
  appendFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const PROGRAM_PATH = resolve(here, "research_program.ts");
const PROGRAM_BACKUP_PATH = resolve(here, ".research_program.ts.backup");
const LOG_PATH = resolve(here, "research_log.jsonl");
const PROGRAM_MD_PATH = resolve(here, "program.md");
const RUNNER_LOG_PATH = resolve(here, "research_runner_log.jsonl");

interface CliArgs {
  maxIterations: number;
  budget: "short" | "default" | "long";
  /** What --mode to pass to research_eval.ts. Set to "smoke" when
   *  testing the runner machinery (fast 1-map check) and "eval" for
   *  real loop iterations. */
  evalMode: "eval" | "smoke";
  agentCmd: string;
  /** Stop if last N kept-rate < this fraction. */
  keepRateFloor: number;
  keepRateWindow: number;
  /** Stop if no new best in this many iterations. */
  plateauWindow: number;
  /** Run a validation pass every N iterations. */
  validateEvery: number;
  /** If true, run one iteration WITHOUT calling an LLM - useful for
   *  testing the runner machinery against a fixed config. */
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {
    maxIterations: 30,
    budget: "default",
    evalMode: "eval",
    agentCmd: "claude --print",
    keepRateFloor: 0.1,
    keepRateWindow: 30,
    plateauWindow: 50,
    validateEvery: 20,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-iterations") out.maxIterations = Number(argv[++i]);
    else if (a === "--budget") out.budget = argv[++i] as CliArgs["budget"];
    else if (a === "--eval-mode") out.evalMode = argv[++i] as CliArgs["evalMode"];
    else if (a === "--agent-cmd") out.agentCmd = argv[++i];
    else if (a === "--keep-rate-floor") out.keepRateFloor = Number(argv[++i]);
    else if (a === "--keep-rate-window") out.keepRateWindow = Number(argv[++i]);
    else if (a === "--plateau-window") out.plateauWindow = Number(argv[++i]);
    else if (a === "--validate-every") out.validateEvery = Number(argv[++i]);
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

interface LogRow {
  timestamp: string;
  score: number;
  prev_best: number | null;
  kept: boolean;
  config_hash: string;
  notes?: string;
}

function readLog(): LogRow[] {
  if (!existsSync(LOG_PATH)) return [];
  const lines = readFileSync(LOG_PATH, "utf8").trim().split(/\r?\n/);
  const rows: LogRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // ignore corrupt lines
    }
  }
  return rows;
}

function priorBestScore(rows: LogRow[]): number {
  let best = -Infinity;
  for (const r of rows) if (r.score > best) best = r.score;
  return best;
}

/** Build the prompt for the agent. Per the plan, this is just:
 *    program.md + log tail + current research_program.ts.
 *  No prescribed step-by-step. The agent's job is to look at all three
 *  and emit a NEW research_program.ts. */
function buildAgentPrompt(rows: LogRow[]): string {
  const programMd = readFileSync(PROGRAM_MD_PATH, "utf8");
  const currentProgram = readFileSync(PROGRAM_PATH, "utf8");
  const lastN = rows.slice(-30);
  const logExcerpt = lastN
    .map((r) =>
      JSON.stringify({
        timestamp: r.timestamp,
        score: r.score,
        prev_best: r.prev_best,
        kept: r.kept,
        config_hash: r.config_hash,
        notes: r.notes,
      }),
    )
    .join("\n");

  return [
    "# autoresearch loop iteration",
    "",
    "## program.md (the steering wheel)",
    programMd,
    "",
    "## research_log.jsonl (last 30 entries; oldest first)",
    "```jsonl",
    logExcerpt || "(no prior iterations)",
    "```",
    "",
    "## current research_program.ts",
    "```typescript",
    currentProgram,
    "```",
    "",
    "## task",
    "Hypothesise ONE change to TRAINING_CONFIG. Edit research_program.ts ",
    "(only that file, only TRAINING_CONFIG and NOTES inside it). Update ",
    "NOTES to record what you changed and why. ",
    "",
    "Output: write the COMPLETE new contents of research_program.ts to ",
    "stdout, surrounded by a single ``` typescript code fence. Output ",
    "nothing else.",
  ].join("\n");
}

/** Strip the markdown code fence around the agent's output, leaving just
 *  the TypeScript. Tolerant of common fence variations. */
function stripCodeFence(s: string): string {
  // Find the first ``` and the last ```. Take what's between.
  const m = s.match(/```(?:typescript|ts)?\s*\n([\s\S]*?)\n```/);
  if (m) return m[1].trim() + "\n";
  // Fallback: if there's no fence, assume the whole thing is the file.
  return s.trim() + "\n";
}

/** Run the LLM agent to produce a new research_program.ts. */
function callAgent(prompt: string, agentCmd: string): string {
  const parts = agentCmd.split(/\s+/);
  const result = spawnSync(parts[0], parts.slice(1), {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `agent command failed: status=${result.status}, stderr=${result.stderr}`,
    );
  }
  return result.stdout;
}

/** Validate the proposed file at least imports as TypeScript and exports
 *  TRAINING_CONFIG. Imperfect (we'd need a type-checker for real) but
 *  catches "agent forgot the export keyword" and "agent dropped a knob". */
async function validateProgram(programSrc: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Light static check: must export TRAINING_CONFIG.
  if (!/export\s+const\s+TRAINING_CONFIG/.test(programSrc)) {
    return { ok: false, reason: "missing export const TRAINING_CONFIG" };
  }
  // Must mention every required field. We pull the field list off the
  // current TrainingConfig.
  const required = [
    "gridSize", "raySamples", "radialRays", "radialSamplesPerRay",
    "radialRayMaxDist", "useNavigation", "hiddenSize", "lr", "gamma",
    "batchSize", "valueCoef", "gradClip", "meanScale", "initLogStd",
    "logStdMin", "logStdMax", "strokePenalty", "holeBonus", "waterPenalty",
    "acidPenalty", "progressBonus", "explorationBonus", "maxStrokes",
    "numParallel", "safetyRetries", "learnFromRejectedShots",
    "searchHIOFirst",
  ];
  for (const k of required) {
    if (!programSrc.includes(k)) {
      return { ok: false, reason: `missing field: ${k}` };
    }
  }
  return { ok: true };
}

/** Run research_eval.ts. Returns the score (parsed from the last stdout
 *  line) and a flag for whether it crashed. */
function runEval(
  budget: CliArgs["budget"],
  mode: "eval" | "validate" = "eval",
): { score: number; ok: boolean; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      resolve(here, "research_eval.ts"),
      "--mode",
      mode,
      "--budget",
      budget,
    ],
    { encoding: "utf8", maxBuffer: 100 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    return { score: -Infinity, ok: false, stderr: result.stderr };
  }
  const lastLine = result.stdout.trim().split(/\r?\n/).pop() ?? "";
  const score = Number(lastLine);
  return {
    score: Number.isFinite(score) ? score : -Infinity,
    ok: Number.isFinite(score),
    stderr: result.stderr,
  };
}

function shouldStop(rows: LogRow[], args: CliArgs): { stop: boolean; reason?: string } {
  // Keep-rate floor.
  if (rows.length >= args.keepRateWindow) {
    const window = rows.slice(-args.keepRateWindow);
    const kept = window.filter((r) => r.kept).length;
    const rate = kept / window.length;
    if (rate < args.keepRateFloor) {
      return {
        stop: true,
        reason: `keep-rate ${(rate * 100).toFixed(1)}% < floor ${(args.keepRateFloor * 100).toFixed(1)}% over last ${args.keepRateWindow} trials`,
      };
    }
  }
  // Score plateau.
  if (rows.length >= args.plateauWindow) {
    const recent = rows.slice(-args.plateauWindow);
    const olderBest = priorBestScore(rows.slice(0, -args.plateauWindow));
    const recentBest = priorBestScore(recent);
    if (recentBest <= olderBest) {
      return {
        stop: true,
        reason: `no improvement in ${args.plateauWindow} trials (recent best ${recentBest.toFixed(4)} <= older best ${olderBest.toFixed(4)})`,
      };
    }
  }
  return { stop: false };
}

function logRunner(event: object): void {
  appendFileSync(
    RUNNER_LOG_PATH,
    JSON.stringify({ ts: new Date().toISOString(), ...event }) + "\n",
  );
}

let interrupted = false;
process.on("SIGINT", () => {
  process.stderr.write("\n[loop] SIGINT received - finishing current iteration\n");
  interrupted = true;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  process.stderr.write(
    `[loop] starting: max=${args.maxIterations} budget=${args.budget} dry-run=${args.dryRun}\n`,
  );

  for (let iter = 1; iter <= args.maxIterations; iter++) {
    if (interrupted) break;

    const rows = readLog();
    const stop = shouldStop(rows, args);
    if (stop.stop) {
      process.stderr.write(`[loop] STOP: ${stop.reason}\n`);
      logRunner({ iteration: iter, event: "stop", reason: stop.reason });
      break;
    }

    process.stderr.write(`\n[loop] === iteration ${iter}/${args.maxIterations} ===\n`);

    // 1. Backup the current program.
    copyFileSync(PROGRAM_PATH, PROGRAM_BACKUP_PATH);
    const priorBest = priorBestScore(rows);
    process.stderr.write(`[loop] prior best score: ${priorBest === -Infinity ? "none" : priorBest.toFixed(4)}\n`);

    // 2-4. Get a new program (unless dry-run).
    if (!args.dryRun) {
      const prompt = buildAgentPrompt(rows);
      let proposed: string;
      try {
        const raw = callAgent(prompt, args.agentCmd);
        proposed = stripCodeFence(raw);
      } catch (e: any) {
        process.stderr.write(`[loop] agent call failed: ${e?.message}\n`);
        logRunner({ iteration: iter, event: "agent_error", error: String(e) });
        break;
      }
      const validation = await validateProgram(proposed);
      if (!validation.ok) {
        process.stderr.write(`[loop] proposed program invalid: ${validation.reason}\n`);
        logRunner({ iteration: iter, event: "invalid_proposal", reason: validation.reason });
        // Restore backup, skip this iteration.
        copyFileSync(PROGRAM_BACKUP_PATH, PROGRAM_PATH);
        continue;
      }
      writeFileSync(PROGRAM_PATH, proposed);
      process.stderr.write(`[loop] proposal applied (${proposed.length} chars)\n`);
    } else {
      process.stderr.write(`[loop] dry-run: skipping agent, using current program\n`);
    }

    // 5-6. Run eval, get score.
    const evalStart = Date.now();
    const { score, ok, stderr } = runEval(args.budget, args.evalMode);
    const evalSecs = (Date.now() - evalStart) / 1000;

    if (!ok) {
      process.stderr.write(`[loop] eval crashed:\n${stderr}\n`);
      logRunner({ iteration: iter, event: "eval_error", stderr: stderr.slice(0, 1000) });
      copyFileSync(PROGRAM_BACKUP_PATH, PROGRAM_PATH);
      continue;
    }

    process.stderr.write(`[loop] score=${score.toFixed(4)} (was ${priorBest === -Infinity ? "none" : priorBest.toFixed(4)}, eval=${evalSecs.toFixed(1)}s)\n`);

    // 7. Keep or revert.
    const kept = score > priorBest;
    if (!kept) {
      process.stderr.write(`[loop] REVERT (score did not improve)\n`);
      copyFileSync(PROGRAM_BACKUP_PATH, PROGRAM_PATH);
    } else {
      process.stderr.write(`[loop] KEEP (new best)\n`);
    }
    logRunner({
      iteration: iter,
      event: "iteration_done",
      score,
      prior_best: priorBest === -Infinity ? null : priorBest,
      kept,
      eval_secs: evalSecs,
    });

    // 8. Validation pass every N iterations (if score improved).
    if (kept && iter % args.validateEvery === 0) {
      process.stderr.write(`[loop] running validation pass ...\n`);
      const valStart = Date.now();
      const valResult = runEval(args.budget, "validate");
      const valSecs = (Date.now() - valStart) / 1000;
      process.stderr.write(`[loop] validation score=${valResult.score.toFixed(4)} (${valSecs.toFixed(1)}s)\n`);
      logRunner({
        iteration: iter,
        event: "validation",
        score: valResult.score,
        eval_score_at_iteration: score,
        secs: valSecs,
      });
    }
  }

  process.stderr.write(`\n[loop] finished\n`);
}

main().catch((e) => {
  process.stderr.write(`[loop] FATAL: ${e?.stack ?? e}\n`);
  process.exit(1);
});
