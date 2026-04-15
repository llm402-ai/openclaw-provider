/**
 * Plugin configuration validation via Zod.
 * Validates auth fields from openclaw.plugin.json at activation time.
 */

import { z } from 'zod';
import { isValidBaseUrl } from './lib/index.js';

const BALANCE_TOKEN_RE = /^bal_[A-Za-z0-9_-]{43}$/;
const EVM_KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const NSEC_RE = /^nsec1[a-z0-9]{58}$/;

/**
 * Production baseUrl — hardcoded.
 *
 * In production release builds, the plugin talks to exactly this host.
 * Users cannot override via OpenClaw auth config (the `baseUrl` field is
 * not exposed in openclaw.plugin.json).
 *
 * Dev/test override: set env `LLM402_BASE_URL_OVERRIDE`. Guarded by the
 * same isValidBaseUrl check (HTTPS, no private IPs).
 */
export const BASEURL_PROD = 'https://llm402.ai';

/**
 * Base RPC URL for viem wallet client (x402 mode).
 *
 * Dev/test override: env `LLM402_BASE_RPC_URL_OVERRIDE` — must match the
 * Base-mainnet allowlist. Any other value is rejected at startup.
 */
export const BASE_RPC_URL_PROD = 'https://mainnet.base.org';
const BASE_RPC_URL_ALLOWLIST = new Set<string>([
  'https://mainnet.base.org',
  'https://base.llamarpc.com',
  'https://base-rpc.publicnode.com',
  'https://developer-access-mainnet.base.org',
]);

export function resolveBaseUrl(): string {
  const override = process.env.LLM402_BASE_URL_OVERRIDE;
  if (!override) return BASEURL_PROD;
  if (!isValidBaseUrl(override)) {
    throw new Error(
      `LLM402_BASE_URL_OVERRIDE rejected: must be HTTPS with no private IPs. Got: ${override}`
    );
  }
  return override;
}

export function resolveBaseRpcUrl(): string {
  const override = process.env.LLM402_BASE_RPC_URL_OVERRIDE;
  if (!override) return BASE_RPC_URL_PROD;
  if (!BASE_RPC_URL_ALLOWLIST.has(override)) {
    throw new Error(
      `LLM402_BASE_RPC_URL_OVERRIDE not in allowlist. Allowed: ${Array.from(BASE_RPC_URL_ALLOWLIST).join(', ')}`
    );
  }
  return override;
}

export const PluginConfigSchema = z.object({
  paymentMode: z.enum(['balance', 'cashu', 'x402', 'lightning']).default('balance'),
  balanceToken: z.string().regex(BALANCE_TOKEN_RE, 'Invalid balance token format').optional(),
  cashuNsec: z.string().regex(NSEC_RE, 'Invalid nsec format').optional(),
  evmPrivateKey: z.string().regex(EVM_KEY_RE, 'Invalid EVM private key format').optional(),
  maxRequestBudgetSats: z.number().int().positive().max(50_000).default(500),        // ≤ ~$50 per request
  sessionBudgetSats: z.number().int().positive().max(1_000_000).default(10_000),     // ≤ ~$1000 session (sats)
  sessionBudgetUsdcCents: z.number().int().positive().max(500_000).default(5_000),   // ≤ $5000 session (USDC)
  baseUrl: z.string().default(BASEURL_PROD).refine(isValidBaseUrl, 'baseUrl must be HTTPS with no private IPs'),
}).refine(
  (data) => {
    switch (data.paymentMode) {
      case 'balance': return !!data.balanceToken;
      case 'cashu': return !!data.cashuNsec;
      case 'x402': return !!data.evmPrivateKey;
      case 'lightning': return !!data.cashuNsec;
      default: return false;
    }
  },
  { message: 'Missing required credential for selected payment mode' }
);

export type PluginConfig = z.infer<typeof PluginConfigSchema>;

export function validateConfig(raw: Record<string, unknown>): PluginConfig {
  return PluginConfigSchema.parse(raw);
}
