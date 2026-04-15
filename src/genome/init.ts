/**
 * Re-export shim — real implementation lives in @ashlr/core-efficiency/genome.
 * Kept here so existing internal imports (`from "./init.ts"` and
 * `from "../genome/init.ts"`) continue to resolve without callsite changes.
 */
export * from "@ashlr/core-efficiency/genome";
