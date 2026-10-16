/**
 * MCP OAuth 2.0 — thin wrapper around @ashlr/auth/oauth.
 *
 * All PKCE, token-cache, and refresh logic now lives in the shared package.
 * This module re-exports the types and adds the ashlrcode-specific
 * `getConfigDir()`-based convenience wrappers so callers don't need to
 * import or invoke getConfigDir() themselves.
 */

export type { OAuthConfig, TokenSet } from "@ashlr/auth/oauth";
export {
  authorizeWithPKCE,
  exchangeCodeForToken,
  cacheToken,
  loadCachedToken,
  clearCachedToken,
  refreshToken,
  refreshTokenIfNeeded,
  generatePKCE,
} from "@ashlr/auth/oauth";

import { authorizeOAuth as _authorizeOAuth, clearCachedToken as _clearCachedToken } from "@ashlr/auth/oauth";
import type { OAuthConfig, TokenSet } from "@ashlr/auth/oauth";
import { getConfigDir } from "../config/settings.ts";

/**
 * Run the full OAuth 2.0 PKCE flow for an MCP server.
 * cacheDir is resolved from getConfigDir() automatically.
 */
export async function authorizeOAuth(
  serverId: string,
  config: OAuthConfig
): Promise<TokenSet> {
  return _authorizeOAuth(getConfigDir(), serverId, config);
}

/**
 * Delete the cached token for a server.
 * @deprecated Use clearCachedToken(cacheDir, serverId) from @ashlr/auth/oauth directly.
 */
export async function revokeToken(serverId: string): Promise<void> {
  return _clearCachedToken(getConfigDir(), serverId);
}
