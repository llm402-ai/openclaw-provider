/**
 * @llm402/openclaw-provider — OpenClaw provider plugin for llm402.ai
 *
 * All modes route through a local proxy (ClawRouter pattern):
 *   - Balance mode: proxy injects Bearer header (zero latency, no 402)
 *   - Wallet modes: proxy handles probe-pay-retry (Cashu/x402/L402)
 *
 * OpenClaw never sees 402 responses — the proxy absorbs them.
 */

import { randomBytes } from 'crypto';
import { Llm402Wallet } from './lib/index.js';
import { validateConfig } from './config.js';
import { BudgetTracker } from './budget.js';
import { ModelCatalog } from './catalog.js';
import { PaymentProxy } from './proxy.js';
import { assertVersionNotBroken, PLUGIN_VERSION } from './version.js';
import { redactSecrets } from './redact.js';

// Guard against double-activation — only one proxy per process
let activeProxy: PaymentProxy | null = null;

/**
 * Minimal shape of the OpenClaw plugin API passed to `register(api)` in the
 * modern entry contract. We redefine locally rather than importing from
 * `openclaw` because that package is an optional peerDep (user-supplied)
 * and we want to build/type-check without it installed.
 *
 * We accept `unknown` for provider config to stay forward-compatible with
 * SDK shape changes — the object we hand to `registerProvider` is the same
 * one the legacy `activate()` path returns.
 */
interface OpenClawPluginApi {
  registerProvider: (config: unknown) => void | Promise<void>;
}

interface PluginEntry {
  id: string;
  name: string;
  register(api: OpenClawPluginApi): void | Promise<void>;
}

/**
 * Type-safe entry constructor. OpenClaw's loader imports this module's
 * default export and calls `register(api)`. Identity function — just
 * constrains the shape at compile time.
 */
function definePluginEntry<T extends PluginEntry>(entry: T): T {
  return entry;
}

/**
 * Activate the plugin. Called by OpenClaw on plugin load.
 * Returns the provider registration for OpenClaw.
 */
export async function activate(authConfig: Record<string, unknown>): Promise<{
  providerId: string;
  displayName: string;
  baseUrl: string;
  models: () => Promise<Array<{ id: string; name: string }>>;
  shutdown: () => Promise<void>;
}> {
  // Refuse to run if this build is marked broken (defense-in-depth vs npm
  // deprecate — npm warns at install, this fires at activate).
  assertVersionNotBroken();

  // Prevent double-activation leaking proxy servers
  if (activeProxy?.isRunning()) {
    await activeProxy.stop();
    activeProxy = null;
  }

  const config = validateConfig(authConfig);
  // Budget tracker with sats (L402/Cashu/balance) AND USDC cents (x402) rails
  const budget = new BudgetTracker(
    config.maxRequestBudgetSats,
    config.sessionBudgetSats,
    config.sessionBudgetUsdcCents,
  );
  const catalog = new ModelCatalog(config.baseUrl);

  let wallet: Llm402Wallet | null = null;
  let balanceToken: string | undefined;

  if (config.paymentMode === 'balance') {
    balanceToken = config.balanceToken;
  } else {
    wallet = new Llm402Wallet();
    try {
      if (config.paymentMode === 'cashu' || config.paymentMode === 'lightning') {
        await wallet.init(config.cashuNsec, config.evmPrivateKey);
      } else if (config.paymentMode === 'x402') {
        await wallet.init(undefined, config.evmPrivateKey);
      }
    } catch (err) {
      throw new Error(
        `Failed to initialize wallet for ${config.paymentMode} mode: ${redactSecrets(err)}. ` +
        `Check your credentials and ensure the Cashu mint is reachable.`
      );
    }
  }

  // Generate a per-session auth token for the proxy to prevent unauthorized local access.
  // Any local process that discovers the port cannot spend from the wallet without this token.
  const proxyAuthToken = randomBytes(32).toString('hex');

  const proxy = new PaymentProxy({
    targetUrl: config.baseUrl,
    wallet,
    budget,
    balanceToken,
    proxyAuthToken,
  });
  activeProxy = proxy;

  await proxy.start();
  const baseUrl = proxy.getBaseUrl();
  console.error(`[llm402] v${PLUGIN_VERSION} ${config.paymentMode} mode — proxy on ${baseUrl}`);

  // Pre-fetch model catalog
  const models = await catalog.getModels();
  console.error(`[llm402] ${models.length} models available`);

  return {
    providerId: 'llm402',
    displayName: 'llm402.ai',
    // OpenClaw must set header `x-proxy-auth: <proxyAuthToken>` on every request
    // to this baseUrl. The proxy does a constant-time comparison — any mismatch
    // (wrong value, Authorization Bearer, missing header) returns 403.
    // See proxy.ts:handleRequest for the validation.
    baseUrl,

    models: async () => {
      const m = await catalog.getModels();
      return m.map((model) => ({ id: model.id, name: model.name }));
    },

    shutdown: async () => {
      await proxy.stop();
      activeProxy = null;
      if (wallet) {
        try {
          await wallet.save();
        } catch (err) {
          console.error(`[llm402] WARNING: Failed to save wallet: ${redactSecrets(err)}`);
        }
      }
      console.error('[llm402] Plugin deactivated');
    },
  };
}

/**
 * Modern OpenClaw plugin entry (default export).
 *
 * Per https://docs.openclaw.ai/tools/plugin, OpenClaw v2026.4.x+ imports
 * a plugin's default export and calls `register(api)`. The `api` object
 * exposes `registerProvider(...)`. Older OpenClaw versions fall back to
 * calling the named `activate()` export above — both paths converge on
 * the same `activate(authConfig)` function and produce the same provider
 * spec, so behavior is identical whichever loader path is taken.
 *
 * ID CONVENTIONS (these are legitimately different, not a typo):
 *   - `openclaw.plugin.json: id = "llm402-provider"` — plugin id
 *   - `providerId = "llm402"` — the LLM provider id inside the plugin
 *     (a single plugin can register multiple providers)
 *   - `package.json: openclaw.providers = ["llm402"]` — advertises which
 *     provider ids the plugin registers (matches providerId)
 *
 * AUTH CONFIG PATH (partial SDK unknown, fallback supported):
 *   OpenClaw's `api.registerProvider` contract for passing authConfig
 *   is not publicly documented in the snapshot we built against.
 *   We try three resolution strategies in order:
 *     1. `api.getAuthConfig()` — hypothetical getter
 *     2. `api.authConfig` — hypothetical property
 *     3. `{}` empty — falls back to schema defaults; `validateConfig`
 *        will throw loudly if required credentials are missing
 *   If SDK shape is confirmed in Layer 10 E2E, this narrows to the
 *   correct path in v0.2.1.
 */
export default definePluginEntry({
  id: 'llm402-provider',
  name: 'llm402.ai',
  async register(api: OpenClawPluginApi): Promise<void> {
    const authConfig = resolveAuthConfig(api);
    const provider = await activate(authConfig);
    await api.registerProvider(provider);
  },
});

/**
 * Exported for test use. Resolves auth config from OpenClaw's `api`
 * object by trying multiple conventions. Never throws; returns `{}` on
 * no-match (validateConfig will loudly reject missing credentials later).
 */
export function resolveAuthConfig(api: OpenClawPluginApi): Record<string, unknown> {
  const bag = api as unknown as {
    getAuthConfig?: () => Record<string, unknown>;
    authConfig?: Record<string, unknown>;
  };
  if (typeof bag.getAuthConfig === 'function') {
    const val = bag.getAuthConfig();
    if (val && typeof val === 'object') return val;
  }
  if (bag.authConfig && typeof bag.authConfig === 'object') {
    return bag.authConfig;
  }
  return {};
}
