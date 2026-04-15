/**
 * LLM402 HTTP Client — handles X-Cashu, x402 USDC, and L402 payments.
 *
 * Payment fallback chain:
 *   Cashu → x402 (USDC on Base) → L402 (melt Cashu to Lightning)
 *
 * Security: fail-closed on all payment errors. Never leak nsec or EVM key.
 */

import { createWalletClient, createPublicClient, http, formatUnits, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { randomBytes } from 'crypto';
import type { Llm402Wallet } from './wallet.js';
import type {
  ChatCompletionResponse,
  ChatMessage,
  ModelsResponse,
  PaymentRequiredResponse,
  X402PaymentPayload,
  X402PaymentRequirement,
  ProbeResult,
} from './types.js';
import {
  parsePaymentRequiredHeader,
  resolveX402Requirement,
  USDC_ADDRESS,
  EXPECTED_PAYTO,
  EXPECTED_NETWORK,
  MAX_USDC_PER_REQUEST_ATOMIC,
  USDC_EIP712_DOMAIN,
} from './x402.js';

const DEFAULT_BASE_URL = 'https://llm402.ai';
const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes — LLM inference can be slow
const BASE_RPC_URL = process.env.LLM402_BASE_RPC_URL || 'https://mainnet.base.org';
const USDC_ABI = [{
  inputs: [{ name: 'account', type: 'address' }],
  name: 'balanceOf',
  outputs: [{ type: 'uint256' }],
  stateMutability: 'view',
  type: 'function',
}] as const;

// EIP-3009 TransferWithAuthorization types for EIP-712 signing
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

// Safety cap: reject any single request costing more than this (sats)
const MAX_REQUEST_PRICE_SATS = 5_000;

/** Validate a base URL: HTTPS only, no private IPs, no localhost. */
export function isValidBaseUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const h = parsed.hostname.toLowerCase();
  // Block localhost variants
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]') return false;
  // Block IPv6 private ranges (ULA, link-local, loopback, IPv4-mapped)
  if (h.startsWith('::ffff:') || h.startsWith('fd') || h.startsWith('fc') ||
      h.startsWith('fe80') || h.startsWith('::1')) return false;
  // Block IPv6 in brackets
  const bracketless = h.startsWith('[') ? h.slice(1, -1) : h;
  if (bracketless.startsWith('::ffff:') || bracketless.startsWith('fd') || bracketless.startsWith('fc') ||
      bracketless.startsWith('fe80') || bracketless === '::1') return false;
  // Block IPv4 private ranges
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (ipv4) {
    const a = Number(ipv4[1]), b = Number(ipv4[2]);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 169 && b === 254) || a === 0 || a === 127) return false;
  }
  return true;
}

export interface LLM402ClientOptions {
  /** Allow insecure (HTTP, private IP) base URLs. For development/CI only. Default: false. */
  allowInsecure?: boolean;
}

export class LLM402Client {
  private baseUrl: string;
  private wallet: Llm402Wallet;
  private balanceToken: string | null;
  private maxPriceSats: number;
  private maxPriceSatsExplicit: boolean;

  constructor(wallet: Llm402Wallet, baseUrl?: string, balanceToken?: string, maxPriceSats?: number, opts?: LLM402ClientOptions) {
    this.wallet = wallet;
    const url = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    // Validate URL unless explicitly opted out for development
    if (baseUrl && !(opts?.allowInsecure) && !isValidBaseUrl(url)) {
      throw new Error(`Unsafe base URL: ${url}. Must be HTTPS with no private IPs. Set allowInsecure for development.`);
    }
    this.baseUrl = url;
    this.balanceToken = balanceToken && /^bal_[A-Za-z0-9_-]{43}$/.test(balanceToken) ? balanceToken : null;
    if (maxPriceSats !== undefined && (!Number.isFinite(maxPriceSats) || maxPriceSats <= 0)) {
      throw new Error('maxPriceSats must be a positive finite number');
    }
    this.maxPriceSats = maxPriceSats ?? MAX_REQUEST_PRICE_SATS;
    this.maxPriceSatsExplicit = maxPriceSats !== undefined;
  }

  /**
   * Set or clear the balance token for Bearer auth.
   */
  setBalanceToken(token: string | null): void {
    if (token && !/^bal_[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new Error('Invalid balance token format. Expected: bal_ followed by 43 base64url chars.');
    }
    this.balanceToken = token;
  }

  /**
   * Send a chat completion request.
   *
   * Fallback chain: Balance → Cashu → x402 (USDC) → L402 (Lightning)
   */
  async chatCompletion(params: {
    messages: ChatMessage[];
    model?: string;
    pref?: string;
    max_tokens?: number;
    temperature?: number;
    stream?: boolean;
  }): Promise<ChatCompletionResponse> {
    const body = {
      model: params.model || 'auto',
      messages: params.messages,
      max_tokens: params.max_tokens ?? 8192,
      temperature: params.temperature,
      pref: params.pref,
      stream: false, // Wallet-based payments require buffered response
    };

    // Step 0: Try balance token (fastest — no probe needed, no 402 round-trip)
    if (this.balanceToken) {
      // If caller set an explicit price cap, probe first to enforce it.
      // This adds one round-trip but ensures the safety cap is respected.
      // When maxPriceSats is at the default, skip the probe for latency.
      if (this.maxPriceSatsExplicit) {
        const probeResult = await this.probe('/v1/chat/completions', { ...body, stream: false });
        if (probeResult) {
          const priceSats = probeResult.body.cashu?.price_sats ?? probeResult.body.price;
          if (priceSats && Number.isFinite(priceSats) && priceSats > this.maxPriceSats) {
            throw new Error(`Server price ${priceSats} sats exceeds safety cap of ${this.maxPriceSats} sats`);
          }
        }
      }
      try {
        return await this.payWithBalance('/v1/chat/completions', {
          ...body,
          stream: params.stream ?? false, // Balance tokens support streaming
        });
      } catch (balErr) {
        const balMsg = balErr instanceof Error ? balErr.message : String(balErr);
        // If token is depleted or invalid, fall through to wallet-based payment
        console.error(`[client] Balance token failed (${balMsg}), trying wallet payment...`);
      }
    }

    // Step 1: Probe for exact price (send without payment, expect 402)
    const probeResult = await this.probe('/v1/chat/completions', body);

    if (!probeResult) {
      throw new Error('Server did not require payment. Unexpected.');
    }

    const priceSats = probeResult.body.cashu?.price_sats ?? probeResult.body.price;
    if (!priceSats || !Number.isFinite(priceSats) || priceSats <= 0) {
      throw new Error('Server returned invalid price');
    }
    if (priceSats > this.maxPriceSats) {
      throw new Error(`Server price ${priceSats} sats exceeds safety cap of ${this.maxPriceSats} sats`);
    }

    // Step 2: Try X-Cashu payment
    let cashuErrMsg = '';
    try {
      return await this.payWithCashu('/v1/chat/completions', body, priceSats);
    } catch (cashuErr) {
      cashuErrMsg = cashuErr instanceof Error ? cashuErr.message : String(cashuErr);
      console.error(`[client] X-Cashu failed (${cashuErrMsg}), trying x402...`);
    }

    // Step 3: Try x402 (USDC on Base) if EVM key exists and server supports x402
    // Resolve x402 requirement: prefer v2 Payment-Required header, fallback to body
    let x402ErrMsg = '';
    const evmKey = this.wallet.getEvmPrivateKey();
    const x402Req = resolveX402Requirement(probeResult.envelope, probeResult.body.x402);
    if (evmKey && x402Req) {
      try {
        return await this.payWithX402('/v1/chat/completions', body, x402Req);
      } catch (x402Err) {
        x402ErrMsg = x402Err instanceof Error ? x402Err.message : String(x402Err);
        console.error(`[client] x402 failed (${x402ErrMsg}), trying L402...`);
      }
    }

    // Step 4: L402 fallback — melt tokens to pay the Lightning invoice
    try {
      return await this.payWithL402('/v1/chat/completions', body, probeResult.body);
    } catch (l402Err) {
      const l402Msg = l402Err instanceof Error ? l402Err.message : String(l402Err);
      const parts = [];
      if (this.balanceToken) parts.push('Balance: depleted or invalid');
      parts.push(`Cashu: ${cashuErrMsg}`);
      if (x402ErrMsg) parts.push(`x402: ${x402ErrMsg}`);
      parts.push(`L402: ${l402Msg}`);
      throw new Error(`All payment methods failed. ${parts.join('. ')}`);
    }
  }

  /**
   * List available models (no payment required).
   */
  async listModels(): Promise<ModelsResponse> {
    const url = `${this.baseUrl}/v1/models`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`${res.status}: ${text.slice(0, 200)}`);
      }

      return JSON.parse(text) as ModelsResponse;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Request to /v1/models timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  // --- Internal methods ---

  /**
   * Probe: send request without payment to get 402 response with exact price.
   * Returns both the response body and the parsed Payment-Required v2 header.
   */
  private async probe(path: string, body: unknown): Promise<ProbeResult | null> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();

      if (res.status === 402) {
        const responseBody = JSON.parse(text) as PaymentRequiredResponse;
        const envelope = parsePaymentRequiredHeader(res.headers.get('payment-required'));
        return { body: responseBody, envelope };
      }

      // If somehow we got a 200 without payment (shouldn't happen)
      if (res.ok) {
        return null;
      }

      throw new Error(`Probe failed: ${res.status} ${text.slice(0, 200)}`);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Price probe timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Pay with balance token: send with Bearer auth, no probe needed.
   * Supports streaming since server handles deduction atomically.
   */
  private async payWithBalance(
    path: string,
    body: unknown,
  ): Promise<ChatCompletionResponse> {
    if (!this.balanceToken) throw new Error('No balance token configured');

    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.balanceToken}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();

      if (!res.ok) {
        let errorMsg: string;
        try {
          const errJson = JSON.parse(text);
          errorMsg = typeof errJson.error === 'string'
            ? errJson.error
            : errJson.error?.message ?? text.slice(0, 200);
        } catch {
          errorMsg = text.slice(0, 200);
        }
        throw new Error(`Balance payment failed: ${res.status} ${errorMsg}`);
      }

      return JSON.parse(text) as ChatCompletionResponse;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Balance inference request timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Pay with X-Cashu: select proofs, encode token, send with header.
   */
  private async payWithCashu(
    path: string,
    body: unknown,
    priceSats: number
  ): Promise<ChatCompletionResponse> {
    // Select proofs for exact price
    const { token } = await this.wallet.selectProofs(priceSats);

    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Cashu': token,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();

      // Check for change tokens in response header (future server feature)
      const changeHeader = res.headers.get('X-Cashu-Change');
      if (changeHeader) {
        await this.wallet.addChangeProofs(changeHeader);
      }

      if (!res.ok) {
        let errorMsg: string;
        try {
          const errJson = JSON.parse(text);
          errorMsg = typeof errJson.error === 'string'
            ? errJson.error
            : errJson.error?.message ?? text.slice(0, 200);
        } catch {
          errorMsg = text.slice(0, 200);
        }
        throw new Error(`X-Cashu payment failed: ${res.status} ${errorMsg}`);
      }

      return JSON.parse(text) as ChatCompletionResponse;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Inference request timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * L402 fallback: melt Cashu tokens to pay the Lightning invoice from the 402 response.
   * Then retry with the L402 macaroon + preimage.
   */
  private async payWithL402(
    path: string,
    body: unknown,
    challenge: PaymentRequiredResponse
  ): Promise<ChatCompletionResponse> {
    if (!challenge.invoice || !challenge.macaroon) {
      throw new Error('402 response missing invoice or macaroon for L402');
    }

    // Melt tokens to pay the Lightning invoice
    const { preimage } = await this.wallet.meltForInvoice(challenge.invoice);
    if (!preimage) {
      throw new Error('Lightning payment succeeded but no preimage returned');
    }

    // Retry with L402 auth header
    const authHeader = `L402 ${challenge.macaroon}:${preimage}`;

    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();

      if (!res.ok) {
        let errorMsg: string;
        try {
          const errJson = JSON.parse(text);
          errorMsg = typeof errJson.error === 'string'
            ? errJson.error
            : errJson.error?.message ?? text.slice(0, 200);
        } catch {
          errorMsg = text.slice(0, 200);
        }
        throw new Error(`L402 payment failed: ${res.status} ${errorMsg}`);
      }

      return JSON.parse(text) as ChatCompletionResponse;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('L402 inference request timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Pay with x402: sign EIP-3009 TransferWithAuthorization, send as Payment-Signature.
   * Gasless — CDP facilitator pays gas on Base.
   *
   * @param requirement - Resolved from v2 Payment-Required header or legacy body fallback
   */
  private async payWithX402(
    path: string,
    body: unknown,
    requirement: X402PaymentRequirement,
  ): Promise<ChatCompletionResponse> {
    const evmKey = this.wallet.getEvmPrivateKey();
    if (!evmKey) throw new Error('No EVM key configured');

    const account = privateKeyToAccount(evmKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(BASE_RPC_URL),
    });

    // Use pre-calculated atomic amount from v2 header (or converted from legacy body)
    const amountAtomic = BigInt(requirement.amount);
    if (amountAtomic <= 0n) {
      throw new Error(`x402 amount must be positive, got ${requirement.amount}`);
    }
    // Absolute USDC cap per request — independent of server-provided sats.
    // Cannot be bypassed. $5 = 5_000_000 atomic USDC.
    if (amountAtomic > MAX_USDC_PER_REQUEST_ATOMIC) {
      throw new Error(`x402 amount ${amountAtomic} exceeds per-request USDC cap of ${MAX_USDC_PER_REQUEST_ATOMIC} atomic (~$5)`);
    }

    // SECURITY: Validate server-provided x402 fields against pinned values.
    // A compromised/malicious server could redirect USDC to an attacker's wallet.
    const payTo = getAddress(requirement.payTo);
    if (payTo.toLowerCase() !== EXPECTED_PAYTO.toLowerCase()) {
      throw new Error(`x402 payTo address mismatch: expected ${EXPECTED_PAYTO}, got ${payTo}. Possible payment redirection attack.`);
    }
    if (requirement.asset.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
      throw new Error(`x402 asset mismatch: expected USDC ${USDC_ADDRESS}, got ${requirement.asset}. Possible EIP-712 domain spoofing.`);
    }
    if (requirement.network !== EXPECTED_NETWORK) {
      throw new Error(`x402 network mismatch: expected ${EXPECTED_NETWORK}, got ${requirement.network}. Cross-chain attack vector.`);
    }

    const now = Math.floor(Date.now() / 1000);
    const nonce = ('0x' + randomBytes(32).toString('hex')) as `0x${string}`;

    // Sign EIP-3009 TransferWithAuthorization
    // EIP-712 domain is HARDCODED (consensus: pentester + skeptic — server-provided extra.name/version
    // is a DoS vector with zero benefit since USDC domain is immutable on-chain)
    const signature = await walletClient.signTypedData({
      domain: {
        name: USDC_EIP712_DOMAIN.name,
        version: USDC_EIP712_DOMAIN.version,
        chainId: 8453,
        verifyingContract: USDC_ADDRESS as `0x${string}`,
      },
      types: AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: getAddress(account.address),
        to: payTo,
        value: amountAtomic,
        validAfter: BigInt(now - 60),  // 60s clock-skew tolerance (tightened per audit)
        validBefore: BigInt(now + 120),
        nonce,
      },
    });

    // Build x402 payload — string values for HTTP, BigInt only for signing
    const payload: X402PaymentPayload = {
      x402Version: 2,
      resource: {
        url: `${this.baseUrl}${path}`,
        description: 'LLM inference',
        mimeType: 'application/json',
      },
      accepted: {
        scheme: requirement.scheme,
        network: requirement.network,
        amount: amountAtomic.toString(),
        asset: requirement.asset,
        payTo,
        maxTimeoutSeconds: requirement.maxTimeoutSeconds,
        extra: { name: USDC_EIP712_DOMAIN.name, version: USDC_EIP712_DOMAIN.version },
      },
      payload: {
        signature,
        authorization: {
          from: getAddress(account.address),
          to: payTo,
          value: amountAtomic.toString(),
          validAfter: (now - 60).toString(),
          validBefore: (now + 120).toString(),
          nonce,
        },
      },
    };

    const paymentB64 = Buffer.from(JSON.stringify(payload)).toString('base64');

    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Payment-Signature': paymentB64,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();

      if (!res.ok) {
        let errorMsg: string;
        try {
          const errJson = JSON.parse(text);
          errorMsg = typeof errJson.error === 'string'
            ? errJson.error
            : errJson.error?.message ?? text.slice(0, 200);
        } catch {
          errorMsg = text.slice(0, 200);
        }
        throw new Error(`x402 payment failed: ${res.status} ${errorMsg}`);
      }

      return JSON.parse(text) as ChatCompletionResponse;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('x402 inference request timed out');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Get USDC balance on Base for the wallet's EVM address.
   * Display-only — not used for payment decisions.
   * Returns null if RPC is unreachable (5s timeout).
   */
  async getUsdcBalance(): Promise<{ balance: bigint; formatted: string } | null> {
    const evmAddress = this.wallet.getEvmAddress();
    if (!evmAddress) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    try {
      const publicClient = createPublicClient({
        chain: base,
        transport: http(BASE_RPC_URL, { fetchOptions: { signal: controller.signal } }),
      });

      const balance = await publicClient.readContract({
        address: USDC_ADDRESS,
        abi: USDC_ABI,
        functionName: 'balanceOf',
        args: [evmAddress as `0x${string}`],
      });

      return {
        balance,
        formatted: formatUnits(balance, 6),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
