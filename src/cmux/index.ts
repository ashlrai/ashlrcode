/**
 * cmux integration — barrel export.
 */

export { isCmuxAvailable, ping, resetAvailability } from "./client.ts";
export {
  cmuxSessionStart,
  cmuxSessionEnd,
  cmuxAgentIdle,
  cmuxNeedsInput,
  cmuxToolStart,
  cmuxToolEnd,
  cmuxPromptSubmit,
  cmuxNotify,
  cmuxError,
} from "./hooks.ts";
export { spawnAgentInSplit, canUseSplits, getActiveSplits } from "./splits.ts";
