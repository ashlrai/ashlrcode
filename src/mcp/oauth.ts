/**
 * MCP OAuth 2.0 — authentication flow for MCP servers.
 * Supports authorization code flow with PKCE, token refresh, and API key fallback.
 */

import { createServer } from "http";
import { randomBytes, createHash } from "crypto";
import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { getConfigDir } from "../config/settings.ts";

export interface OAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  scopes: string[];
  redirectPort?: number; // Default: 8742
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // Unix timestamp ms
  tokenType: string;
  scope?: string;
}

function getTokenCachePath(serverId: string): string {
  return join(getConfigDir(), "mcp-tokens", `${serverId}.json`);
}

/** Load cached tokens for an MCP server */
export async function loadCachedToken(
  serverId: string
): Promise<TokenSet | null> {
  const path = getTokenCachePath(serverId);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    const token = JSON.parse(raw) as TokenSet;
    // If expired and no refresh token, discard
    if (token.expiresAt && Date.now() > token.expiresAt - 60_000) {
      if (token.refreshToken) return token; // Can still refresh
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

/** Save tokens to cache */
async function saveToken(serverId: string, token: TokenSet): Promise<void> {
  const dir = join(getConfigDir(), "mcp-tokens");
  await mkdir(dir, { recursive: true });
  await writeFile(
    getTokenCachePath(serverId),
    JSON.stringify(token, null, 2),
    "utf-8"
  );
}

/** Generate PKCE code verifier and challenge (S256) */
function generatePKCE(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Refresh an expired token */
async function refreshAccessToken(
  config: OAuthConfig,
  refreshTokenStr: string
): Promise<TokenSet> {
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshTokenStr,
      client_id: config.clientId,
      ...(config.clientSecret
        ? { client_secret: config.clientSecret }
        : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  return {
    accessToken: data.access_token as string,
    refreshToken:
      (data.refresh_token as string | undefined) ?? refreshTokenStr,
    expiresAt:
      Date.now() + ((data.expires_in as number | undefined) ?? 3600) * 1000,
    tokenType: (data.token_type as string | undefined) ?? "Bearer",
    scope: data.scope as string | undefined,
  };
}

/**
 * Run OAuth 2.0 authorization code flow with PKCE.
 * Opens browser for auth, listens on localhost for redirect.
 * Returns a valid TokenSet (from cache, refresh, or fresh authorization).
 */
export async function authorizeOAuth(
  serverId: string,
  config: OAuthConfig
): Promise<TokenSet> {
  // 1. Check cache — return immediately if still valid
  const cached = await loadCachedToken(serverId);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached;

  // 2. Try refresh if we have a refresh token
  if (cached?.refreshToken) {
    try {
      const refreshed = await refreshAccessToken(config, cached.refreshToken);
      await saveToken(serverId, refreshed);
      return refreshed;
    } catch {
      // Refresh failed — fall through to full authorization
    }
  }

  // 3. Full authorization code flow with PKCE
  const port = config.redirectPort ?? 8742;
  const redirectUri = `http://localhost:${port}/callback`;
  const { verifier, challenge } = generatePKCE();
  const state = randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: redirectUri,
    scope: config.scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authUrl = `${config.authorizationUrl}?${params}`;

  // Open browser (platform-aware)
  const openCmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  Bun.spawn([openCmd, authUrl], { stdout: "pipe", stderr: "pipe" });

  console.log(`\n  🔐 Opening browser for authorization...`);
  console.log(`  If browser doesn't open, visit: ${authUrl}\n`);

  // Listen for the OAuth callback
  const code = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(new Error("OAuth timeout — no callback received within 120s"));
    }, 120_000);

    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:${port}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h1>Authorization Failed</h1><p>You can close this window.</p>"
        );
        clearTimeout(timeout);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (returnedState !== state || !returnedCode) {
        res.writeHead(400);
        res.end("Invalid state or missing code");
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>Authorization Complete</h1><p>You can close this window and return to AshlrCode.</p>"
      );
      clearTimeout(timeout);
      server.close();
      resolve(returnedCode);
    });

    server.listen(port);
  });

  // 4. Exchange authorization code for tokens
  const tokenResponse = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      ...(config.clientSecret
        ? { client_secret: config.clientSecret }
        : {}),
      code_verifier: verifier,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`Token exchange failed: ${tokenResponse.status}`);
  }

  const data = (await tokenResponse.json()) as Record<string, unknown>;
  const token: TokenSet = {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string | undefined,
    expiresAt:
      Date.now() + ((data.expires_in as number | undefined) ?? 3600) * 1000,
    tokenType: (data.token_type as string | undefined) ?? "Bearer",
    scope: data.scope as string | undefined,
  };

  await saveToken(serverId, token);
  console.log("  ✓ Authorization successful\n");
  return token;
}

/** Revoke / delete cached token for a server */
export async function revokeToken(serverId: string): Promise<void> {
  const path = getTokenCachePath(serverId);
  if (existsSync(path)) {
    await unlink(path);
  }
}
