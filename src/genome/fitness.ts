/**
 * Re-export shim — real implementation lives in @ashlr/core-efficiency/genome.
 * Kept here so existing internal imports (`from "./fitness.ts"` and
 * `from "../genome/fitness.ts"`) continue to resolve without callsite changes.
 */
export * from "@ashlr/core-efficiency/genome";
