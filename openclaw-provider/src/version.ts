/**
 * Single source of truth for plugin version + User-Agent.
 *
 * Keep in sync with:
 *   - package.json `version` field
 *   - openclaw.plugin.json `version` field
 *
 * CI asserts all three match (see test/test-hardening.ts).
 * The User-Agent is used:
 *   - By llm402.ai to segment plugin traffic in server logs
 *   - As the kill-switch lever (Cloudflare WAF rule on UA+IP)
 *   - For support debugging ("what version is the user running?")
 */
export const PLUGIN_VERSION = '0.4.0';
export const USER_AGENT = `llm402-openclaw-provider/${PLUGIN_VERSION}`;

/**
 * Versions this build will refuse to activate as. If a released version
 * is later found to have a critical bug, we bake the version string into
 * the next release's KNOWN_BROKEN_VERSIONS and users who auto-update past
 * the broken one won't re-run it.
 *
 * This is defense-in-depth alongside `npm deprecate` — the deprecation
 * warning only fires at install time; this check fires at activate time,
 * which covers the case of a user who already installed the broken build
 * before deprecation reached them.
 *
 * Shipping empty for v0.2.0 (initial public release — nothing to mark).
 */
export const KNOWN_BROKEN_VERSIONS: ReadonlyArray<string> = [];

/**
 * Asserts the current build is not listed as broken.
 * Throws a clear upgrade instruction if it is.
 */
export function assertVersionNotBroken(): void {
  if (KNOWN_BROKEN_VERSIONS.includes(PLUGIN_VERSION)) {
    throw new Error(
      `[llm402] Plugin version ${PLUGIN_VERSION} is marked as broken. ` +
      `Upgrade: npm install @llm402/openclaw-provider@latest`
    );
  }
}
