// THE single mutable file. Per AUTORESEARCH_PLAN.md §2:
//
//   "The agent edits a single file `research_program.ts` that exports:
//      export const TRAINING_CONFIG: TrainingConfig = { /* all 27 knobs */ };
//    Everything else - physics, env.ts, the eval harness, the map list -
//    is frozen."
//
// What this file looks like is therefore very specific:
//
//   - It exports ONE thing: `TRAINING_CONFIG`.
//   - It MAY also export `NOTES` - a free-text string the loop agent
//     uses to remember the rationale behind the current knob values
//     (so iteration N+1's agent can read why iteration N picked these).
//   - That's it. No helper functions, no other exports. The autoresearch
//     loop should be able to read this file and instantly know what's
//     varying.
//
// Where the values came from: the initial values are the production
// DEFAULTS from src/config.ts at the time of handoff. Subsequent edits
// are made by the autonomous loop (research_loop.ts) following the
// hypothesise-edit-test-keep-or-revert rule.
//
// What the loop is NOT allowed to do:
//   - Add new fields to TRAINING_CONFIG (the type is frozen at 27 knobs).
//   - Set values outside AUTORESEARCH_BOUNDS in autoresearch-bounds.ts -
//     the harness will silently clamp them.
//   - Edit any other file. ANY OTHER FILE.

import type { TrainingConfig } from "./src/config.ts";

export const TRAINING_CONFIG: TrainingConfig = {
  // Architecture
  gridSize: 9,
  raySamples: 16,
  radialRays: 8,
  radialSamplesPerRay: 4,
  radialRayMaxDist: 200,
  useNavigation: 1,
  hiddenSize: 32,

  // Optimizer
  lr: 1e-4,
  gamma: 0.99,
  batchSize: 4,
  valueCoef: 0.5,
  gradClip: 100,

  // Action distribution
  meanScale: 80,
  initLogStd: 3.55,
  logStdMin: 1.6,
  logStdMax: 4.4,

  // Reward
  strokePenalty: -1,
  holeBonus: 20,
  waterPenalty: -3,
  acidPenalty: -6,
  progressBonus: 0,
  explorationBonus: 0,

  // Episode / runtime
  maxStrokes: 30,
  numParallel: 4,

  // Safety / search
  safetyRetries: 10,
  learnFromRejectedShots: 0,
  // Deviation from src/config.ts default (which has searchHIOFirst=1):
  // when HIO is on, the brute-force pre-search solves nearly every map
  // in the curated eval set in <3s, before the RL policy gets to play.
  // Score saturates at 1.0 and the metric stops differentiating
  // variants. Off-by-default for the autoresearch baseline so the RL
  // policy is what's being measured. The loop CAN turn HIO back on
  // (it's a valid knob) but the resulting score isn't telling it
  // anything about the policy.
  searchHIOFirst: 0,
};

/** One paragraph the loop agent maintains across iterations. Use it to
 *  record "the most recent change was X because Y; if it succeeds, the
 *  next thing worth trying is Z." Iterations build on each other only
 *  through this note plus the JSONL log - there is no other shared state. */
export const NOTES = `
Initial state: production DEFAULTS from src/config.ts as of handoff,
with searchHIOFirst=0 (HIO off). The HIO brute-force solves nearly
every map in <3s, which saturates the score and leaves the RL policy
invisible to the metric. With HIO off, the score reflects what the
policy actually learns.

No iterations run yet. The loop's first job is to verify the eval
metric reacts to known-good changes (per AUTORESEARCH_PLAN.md §10:
gridSize=5 vs gridSize=11 should differ on hazard maps). After that,
follow program.md.
`.trim();
