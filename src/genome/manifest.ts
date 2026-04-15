/**
 * Re-export shim — real implementation lives in @ashlr/core-efficiency/genome.
 * Kept here so existing internal imports (`from "./manifest.ts"` and
 * `from "../genome/manifest.ts"`) continue to resolve without callsite changes.
 */
export * from "@ashlr/core-efficiency/genome";
