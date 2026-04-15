/**
 * Re-export shim — real implementation lives in @ashlr/core-efficiency/genome.
 * Kept here so existing internal imports (`from "./strategies.ts"` and
 * `from "../genome/strategies.ts"`) continue to resolve without callsite changes.
 */
export * from "@ashlr/core-efficiency/genome";
