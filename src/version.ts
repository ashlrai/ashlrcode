// Use Bun's built-in JSON import so the version is embedded at compile time.
// This works both in dev (bun run) and in compiled binaries (bun build --compile).
import packageJson from "../package.json";

export const VERSION: string = packageJson.version;
