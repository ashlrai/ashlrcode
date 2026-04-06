/**
 * cmux integration — barrel export.
 */

export { isCmuxAvailable, ping, resetAvailability } from "./client.ts";
export {
  cmuxAgentIdle,
  cmuxError,
  cmuxNeedsInput,
  cmuxNotify,
  cmuxPromptSubmit,
  cmuxSessionEnd,
  cmuxSessionStart,
  cmuxToolEnd,
  cmuxToolStart,
} from "./hooks.ts";
export { canUseSplits, getActiveSplits, spawnAgentInSplit } from "./splits.ts";
