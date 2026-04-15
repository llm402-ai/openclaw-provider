/**
 * x402 v2 envelope parsing utilities.
 *
 * Used by the bundled client (./client.ts) and the plugin's payment proxy
 * (../proxy.ts) to read the Payment-Required header from 402 responses.
 *
 * Both functions are PURE and NEVER THROW — they return null on any bad input.
 */

import type { X402Envelope, X402PaymentRequirement, PaymentRequiredResponse } from './types.js';

/** Maximum header length before base64 decode (defense-in-depth). */
const MAX_HEADER_LENGTH = 8192;

/** Amount must be a positive integer string with no leading zeros, max 20 digits. */
const AMOUNT_PATTERN = /^[1-9]\d*$/;
const MAX_AMOUNT_LENGTH = 20;

// --- Pinned security constants (single source of truth) ---
// Shared by the bundled client (./client.ts) and the plugin proxy (../proxy.ts).
// Must match the on-chain/server values. Never trust server-provided alternatives.

/** Base mainnet USDC contract address */
export const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
/** llm402.ai payment receiving wallet */
export const EXPECTED_PAYTO = '0xe05cf38aabc0a046cf0057d2656f3c374132667a' as const;
/** Base mainnet chain identifier */
export const EXPECTED_NETWORK = 'eip155:8453' as const;
/** Absolute per-request USDC cap: $5 = 5_000_000 atomic. Cannot be bypassed. */
export const MAX_USDC_PER_REQUEST_ATOMIC = 5_000_000n;
/** EIP-712 domain for Base mainnet USDC — immutable on-chain, never from server. */
export const USDC_EIP712_DOMAIN = { name: 'USD Coin', version: '2' } as const;

/**
 * Parse the Payment-Required response header from a 402 response.
 *
 * Returns the decoded v2 envelope, or null if the header is missing,
 * malformed, or fails validation. Never throws.
 */
export function parsePaymentRequiredHeader(headerValue: string | null): X402Envelope | null {
  if (!headerValue || headerValue.length > MAX_HEADER_LENGTH) return null;
  // Reject duplicate-header artifacts (HTTP joins repeated headers with ", ")
  if (headerValue.includes(',')) return null;

  try {
    const decoded = Buffer.from(headerValue, 'base64').toString();
    const envelope = JSON.parse(decoded);

    // Must be v2 with non-empty accepts array
    if (envelope.x402Version !== 2) return null;
    if (!Array.isArray(envelope.accepts) || envelope.accepts.length === 0) return null;

    // Type guards on the first (and only) payment requirement
    const req = envelope.accepts[0];
    if (typeof req.amount !== 'string' || typeof req.payTo !== 'string'
        || typeof req.network !== 'string' || typeof req.asset !== 'string'
        || typeof req.scheme !== 'string') {
      return null;
    }

    // Amount must be a valid positive integer string
    if (!AMOUNT_PATTERN.test(req.amount) || req.amount.length > MAX_AMOUNT_LENGTH) {
      return null;
    }

    // extra must have name and version strings (used for EIP-712 domain validation logging)
    if (!req.extra || typeof req.extra.name !== 'string' || typeof req.extra.version !== 'string') {
      return null;
    }

    // Truncate to validated first entry only — unvalidated accepts[1..N] are discarded
    envelope.accepts = [req];
    return envelope as X402Envelope;
  } catch {
    return null;
  }
}

/**
 * Resolve the best X402PaymentRequirement from available sources.
 *
 * Preference: v2 envelope header > legacy response body x402 field.
 * Returns null if neither source provides valid x402 info.
 *
 * The legacy body path converts `price_usd` to atomic amount and maps
 * `address` to `payTo`. This fallback exists for backward compat with
 * servers that don't send the Payment-Required header.
 *
 * TODO: Remove legacy fallback once all llm402.ai servers send the header
 * and a full deploy cycle has passed with zero body-fallback invocations.
 */
export function resolveX402Requirement(
  envelope: X402Envelope | null,
  legacyX402: PaymentRequiredResponse['x402'],
): X402PaymentRequirement | null {
  // Prefer v2 envelope from Payment-Required header
  if (envelope && envelope.accepts.length > 0) {
    return envelope.accepts[0];
  }

  // Fallback to legacy body x402 field — convert to X402PaymentRequirement
  if (!legacyX402) return null;
  if (!legacyX402.price_usd || typeof legacyX402.price_usd !== 'string') return null;
  // Type guards on fields consumed downstream (prevents TypeError on non-string)
  if (typeof legacyX402.network !== 'string' || typeof legacyX402.asset !== 'string'
      || typeof legacyX402.address !== 'string') return null;

  try {
    const priceUsd = parseFloat(legacyX402.price_usd.replace('$', ''));
    if (!Number.isFinite(priceUsd) || priceUsd <= 0 || priceUsd > 5) return null;

    const amountAtomic = BigInt(Math.ceil(priceUsd * 1_000_000));

    // Defense-in-depth: cap at $5 in atomic USDC (matches MAX_USDC_PER_REQUEST_ATOMIC)
    if (amountAtomic <= 0n || amountAtomic > MAX_USDC_PER_REQUEST_ATOMIC) return null;

    return {
      scheme: legacyX402.scheme || 'exact',
      network: legacyX402.network,
      amount: amountAtomic.toString(),
      asset: legacyX402.asset,
      payTo: legacyX402.address,  // body uses "address", header uses "payTo"
      maxTimeoutSeconds: 120,
      extra: { name: USDC_EIP712_DOMAIN.name, version: USDC_EIP712_DOMAIN.version },
    };
  } catch {
    // Honor "never throws" contract — BigInt(Infinity) or other edge cases
    return null;
  }
}
