/**
 * Tests for env-probe capability flags.
 */

import { describe, expect, test } from "bun:test";
import { probeEnv, missingDeployCapabilities, DEPLOY_CAPABILITY_KEYS } from "../autopilot/env-probe.ts";

describe("probeEnv", () => {
  test("all env present → all flags true", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-xxx",
      SPOTIFY_CLIENT_ID: "spid",
      SPOTIFY_CLIENT_SECRET: "spsec",
      VERCEL_TOKEN: "vtok",
      PORKBUN_API_KEY: "pk",
      PORKBUN_SECRET_KEY: "psk",
      STRIPE_SECRET_KEY: "sk",
      SUPABASE_ACCESS_TOKEN: "sup",
      POSTHOG_API_KEY: "ph",
    };
    const probe = probeEnv(env);
    expect(probe.canEnrichReal).toBe(true);
    expect(probe.canIngestSpotify).toBe(true);
    expect(probe.canDeployVercel).toBe(true);
    expect(probe.canDeployPorkbun).toBe(true);
    expect(probe.canDeployStripe).toBe(true);
    expect(probe.canDeploySupabase).toBe(true);
    expect(probe.canDeployPostHog).toBe(true);
    expect(missingDeployCapabilities(probe)).toEqual([]);
  });

  test("missing ANTHROPIC_API_KEY → canEnrichReal false", () => {
    const env = {
      SPOTIFY_CLIENT_ID: "x",
      SPOTIFY_CLIENT_SECRET: "y",
      VERCEL_TOKEN: "v",
      PORKBUN_API_KEY: "p",
      PORKBUN_SECRET_KEY: "ps",
      STRIPE_SECRET_KEY: "s",
      SUPABASE_ACCESS_TOKEN: "sup",
      POSTHOG_API_KEY: "ph",
    };
    const probe = probeEnv(env);
    expect(probe.canEnrichReal).toBe(false);
    expect(probe.canIngestSpotify).toBe(true);
  });

  test("Spotify needs both id and secret", () => {
    expect(probeEnv({ SPOTIFY_CLIENT_ID: "x" }).canIngestSpotify).toBe(false);
    expect(probeEnv({ SPOTIFY_CLIENT_SECRET: "x" }).canIngestSpotify).toBe(false);
    expect(probeEnv({ SPOTIFY_CLIENT_ID: "x", SPOTIFY_CLIENT_SECRET: "y" }).canIngestSpotify).toBe(true);
  });

  test("Supabase accepts either access token or service role key", () => {
    expect(probeEnv({ SUPABASE_SERVICE_ROLE_KEY: "x" }).canDeploySupabase).toBe(true);
    expect(probeEnv({ SUPABASE_ACCESS_TOKEN: "x" }).canDeploySupabase).toBe(true);
    expect(probeEnv({}).canDeploySupabase).toBe(false);
  });

  test("empty env → all deploy capabilities missing", () => {
    const probe = probeEnv({});
    const missing = missingDeployCapabilities(probe);
    expect(missing.sort()).toEqual([...DEPLOY_CAPABILITY_KEYS].sort());
  });

  test("missing VERCEL_TOKEN flagged by missingDeployCapabilities", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk",
      PORKBUN_API_KEY: "p",
      PORKBUN_SECRET_KEY: "ps",
      STRIPE_SECRET_KEY: "s",
      SUPABASE_ACCESS_TOKEN: "sup",
      POSTHOG_API_KEY: "ph",
    };
    const probe = probeEnv(env);
    expect(probe.canDeployVercel).toBe(false);
    expect(missingDeployCapabilities(probe)).toContain("canDeployVercel");
  });
});
