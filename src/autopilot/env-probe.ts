/**
 * Environment probe — capability flags for the artist-encyclopedia-factory
 * autopilot drain. Each flag reports whether the env vars needed to run a
 * given external integration in "real" (non-dry) mode are present.
 *
 * Pure function; no side effects. Pass a custom env map for tests.
 */

export interface EnvProbeResult {
  /** ANTHROPIC_API_KEY present — enrichment LLM calls can run for real. */
  canEnrichReal: boolean;
  /** SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET present. */
  canIngestSpotify: boolean;
  /** VERCEL_TOKEN present. */
  canDeployVercel: boolean;
  /** PORKBUN_API_KEY + PORKBUN_SECRET_KEY present. */
  canDeployPorkbun: boolean;
  /** STRIPE_SECRET_KEY present. */
  canDeployStripe: boolean;
  /** SUPABASE_ACCESS_TOKEN (or SUPABASE_SERVICE_ROLE_KEY) present. */
  canDeploySupabase: boolean;
  /** POSTHOG_API_KEY (or POSTHOG_PROJECT_API_KEY) present. */
  canDeployPostHog: boolean;
}

function has(env: NodeJS.ProcessEnv | Record<string, string | undefined>, key: string): boolean {
  const v = env[key];
  return typeof v === "string" && v.length > 0;
}

export function probeEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): EnvProbeResult {
  return {
    canEnrichReal: has(env, "ANTHROPIC_API_KEY"),
    canIngestSpotify: has(env, "SPOTIFY_CLIENT_ID") && has(env, "SPOTIFY_CLIENT_SECRET"),
    canDeployVercel: has(env, "VERCEL_TOKEN"),
    canDeployPorkbun: has(env, "PORKBUN_API_KEY") && has(env, "PORKBUN_SECRET_KEY"),
    canDeployStripe: has(env, "STRIPE_SECRET_KEY"),
    canDeploySupabase: has(env, "SUPABASE_ACCESS_TOKEN") || has(env, "SUPABASE_SERVICE_ROLE_KEY"),
    canDeployPostHog: has(env, "POSTHOG_API_KEY") || has(env, "POSTHOG_PROJECT_API_KEY"),
  };
}

/**
 * Deploy-related capability keys. Used by `--require-deploy-env` gating:
 * if any of these is false, an artist_build item is deferred.
 */
export const DEPLOY_CAPABILITY_KEYS: Array<keyof EnvProbeResult> = [
  "canDeployVercel",
  "canDeployPorkbun",
  "canDeployStripe",
  "canDeploySupabase",
  "canDeployPostHog",
];

export function missingDeployCapabilities(probe: EnvProbeResult): Array<keyof EnvProbeResult> {
  return DEPLOY_CAPABILITY_KEYS.filter((k) => !probe[k]);
}
