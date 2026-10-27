export { createTask, score } from "./task.js";
export type { Score, Scorer, TaskInstance } from "./task.js";
export { extractAnswer, mathScorer, normalizeNumber } from "./scorers/math.js";
export {
  DEFAULT_LIMITS,
  codegenScorer,
  extractCode,
  runInSandbox,
} from "./scorers/codegen.js";
export type { SandboxLimits, SandboxOutcome, UnitTest } from "./scorers/codegen.js";
export {
  coverageScorer,
  decomposableTasks,
  nonDecomposableTasks,
} from "./tasks/decomposable.js";
export type { Subtopic } from "./tasks/decomposable.js";
export {
  ARMS,
  DEFAULT_TOGGLES,
  SHARED_TOKEN_BUDGET,
  conditionKey,
  enumerateConditions,
  graphToolsFor,
  policyFor,
  rootInstructionsFor,
  rootSpecFor,
} from "./arms.js";
export type { ArmConfig, ArmId, Condition, Toggles } from "./arms.js";
export {
  DEFAULT_REWARD_WEIGHTS,
  collectRoleStats,
  rewardObservations,
} from "./reward.js";
export type { RewardWeights, RoleStats } from "./reward.js";
export { runOne, toJsonLine } from "./harness.js";
export type {
  HarnessOptions,
  HarnessResult,
  ModelFactory,
  RunRecord,
} from "./harness.js";
export {
  MODEL_MATRIX_TEMPLATE,
  MissingCredential,
  faultyModelFactory,
  liveModelFactory,
  withSeedMetadata,
} from "./models.js";
export type { ApiDialect, ModelSpec } from "./models.js";
export {
  conditionFor,
  liveModelMatrix,
  replayGate,
  smokeRun,
  smokeTask,
} from "./live.js";
export type { SmokeResult } from "./live.js";
export {
  cellKey,
  deserializeTranscript,
  estimateCost,
  loadCompletedKeys,
  plannedCells,
  replayFactoryFrom,
  runGrid,
  serializeTranscript,
} from "./runner.js";
export type { Cell, RunSink, RunnerOptions, RunnerSummary } from "./runner.js";
export {
  DEFAULT_OBJECTIVE,
  aggregateByCondition,
  digestConsistency,
  leaveOneOutContribution,
  objectiveValue,
  paretoFront,
  pairedCompare,
  stdDev,
  sweepObjective,
} from "./metrics.js";
export type {
  Aggregate,
  Objective,
  PairedComparison,
  ParetoPoint,
  RoleContribution,
} from "./metrics.js";
export { main as runFullGrid } from "./run-grid.js";
export type { GridOptions } from "./run-grid.js";
