/**
 * Local payment proxy for llm402.ai — ClawRouter pattern.
 *
 * Starts a localhost HTTP server that transparently handles the
 * probe-pay-retry cycle for wallet-based payments (Cashu, x402, L402).
 * OpenClaw registers this proxy as the provider's baseUrl, so OpenClaw
 * never sees the 402 response — it only sees 200 + streamed tokens.
 *
 * Architecture:
 *   OpenClaw → localhost:PORT → proxy:
 *     1. Forward request to llm402.ai WITHOUT payment
 *     2. Receive 402 with price + invoice + macaroon + x402 info
 *     3. Budget check
 *     4. Pay via Cashu → x402 → L402 fallback chain
 *     5. Retry with payment header + stream:true
 *     6. Pipe SSE response back to OpenClaw
 *
 * Security:
 *   - Listens on 127.0.0.1 only (no network exposure)
 *   - Snapshots fetch at import time (prevents plugin-level interception)
 *   - Budget enforcement before any payment
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { timingSafeEqual } from 'crypto';
import type { AddressInfo } from 'net';
import type { Llm402Wallet, PaymentRequiredResponse, X402PaymentRequirement, ProbeResult } from './lib/index.js';
import {
  parsePaymentRequiredHeader,
  resolveX402Requirement,
  USDC_ADDRESS,
  EXPECTED_PAYTO,
  EXPECTED_NETWORK,
  MAX_USDC_PER_REQUEST_ATOMIC,
  USDC_EIP712_DOMAIN,
} from './lib/index.js';
import { BudgetTracker, BudgetError } from './budget.js';
import { USER_AGENT } from './version.js';
import { redactSecrets } from './redact.js';
import { resolveBaseRpcUrl } from './config.js';

// Snapshot fetch to prevent monkey-patching by co-resident plugins
const secureFetch = globalThis.fetch;

const PROBE_TIMEOUT_MS = 30_000;
const INFERENCE_TIMEOUT_MS = 120_000;
const MAX_REQUEST_BODY_BYTES = 1_048_576; // 1MB
const MAX_PROBE_RESPONSE_BYTES = 65_536; // 64KB
const MAX_CATALOG_RESPONSE_BYTES = 1_048_576; // 1MB

/** Read a fetch Response body with a streaming byte cap. Throws if cap exceeded. */
async function readResponseCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        reader.cancel();
        throw new Error(`Response body exceeds ${maxBytes} byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const decoder = new TextDecoder();
  return chunks.map(c => decoder.decode(c, { stream: true })).join('') + decoder.decode();
}

// Security constants imported from ./lib/x402 (single source of truth)

export interface ProxyOptions {
  /** llm402.ai base URL */
  targetUrl: string;
  /** Wallet for Cashu/x402/L402 payments (null for balance-only mode) */
  wallet: Llm402Wallet | null;
  /** Budget tracker */
  budget: BudgetTracker;
  /** Preferred port (0 for auto) */
  port?: number;
  /** Balance token for Bearer auth (bypasses probe-pay-retry) */
  balanceToken?: string;
  /** Per-session auth token — required on all incoming requests to prevent unauthorized local access */
  proxyAuthToken?: string;
}

export class PaymentProxy {
  private server: Server | null = null;
  private targetUrl: string;
  private wallet: Llm402Wallet | null;
  private budget: BudgetTracker;
  private port: number;
  private _actualPort = 0;
  private balanceToken: string | null;
  private proxyAuthToken: string | null;

  constructor(opts: ProxyOptions) {
    this.targetUrl = opts.targetUrl.replace(/\/+$/, '');
    this.wallet = opts.wallet;
    this.budget = opts.budget;
    this.port = opts.port ?? 0; // 0 = OS picks available port
    this.balanceToken = opts.balanceToken ?? null;
    this.proxyAuthToken = opts.proxyAuthToken ?? null;
  }

  /** Start the proxy. Returns the actual port. */
  async start(): Promise<number> {
    if (this.server) {
      return this._actualPort;
    }

    return new Promise((resolve, reject) => {
      const srv = createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          console.error(`[llm402-proxy] Unhandled error: ${redactSecrets(err)}`);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal proxy error' }));
          }
        });
      });

      const onListening = () => {
        const addr = srv.address() as AddressInfo;
        this._actualPort = addr.port;
        this.server = srv;
        console.error(`[llm402-proxy] Listening on 127.0.0.1:${this._actualPort}`);
        resolve(this._actualPort);
      };

      srv.listen(this.port, '127.0.0.1', onListening);

      srv.on('error', (err: NodeJS.ErrnoException) => {
        // If configured port is in use, fall back to OS-assigned random port
        if (err.code === 'EADDRINUSE' && this.port !== 0) {
          console.error(`[llm402-proxy] Port ${this.port} in use, falling back to random port`);
          srv.listen(0, '127.0.0.1', onListening);
        } else {
          reject(err);
        }
      });
    });
  }

  /** Stop the proxy. Drains in-flight requests with a 5s grace period. */
  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    return new Promise((resolve) => {
      // Stop accepting new connections
      srv.close(() => {
        this.server = null;
        console.error('[llm402-proxy] Stopped');
        resolve();
      });
      // Force-close remaining connections after 5s grace period
      setTimeout(() => {
        if (typeof srv.closeAllConnections === 'function') {
          srv.closeAllConnections();
        }
      }, 5_000);
    });
  }

  /** Get the base URL for OpenClaw to use. */
  getBaseUrl(): string {
    return `http://127.0.0.1:${this._actualPort}`;
  }

  /** Is the proxy running? */
  isRunning(): boolean {
    return this.server !== null;
  }

  // --- Request handling ---

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Parse pathname only — strip query strings to prevent routing bypass
    const rawUrl = req.url || '/';
    const path = rawUrl.split('?')[0];

    // Validate proxy auth token if configured (prevents unauthorized local access)
    // Uses constant-time comparison to prevent timing side-channel attacks.
    if (this.proxyAuthToken) {
      const authHeader = req.headers['x-proxy-auth'] as string | undefined;
      const expected = Buffer.from(this.proxyAuthToken);
      const received = Buffer.from(authHeader || '');
      if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    // Health check
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // GET /v1/models — pass through (no payment needed)
    if (req.method === 'GET' && path === '/v1/models') {
      await this.passthrough(req, res, path);
      return;
    }

    // POST /v1/chat/completions — probe-pay-retry
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      await this.handleChatCompletion(req, res);
      return;
    }

    // Unknown route
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  /** Pass through a GET request without payment. */
  private async passthrough(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
      const upstream = await secureFetch(`${this.targetUrl}${path}`, {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });

      const body = await readResponseCapped(upstream, MAX_CATALOG_RESPONSE_BYTES);
      const contentType = upstream.headers.get('content-type') || 'application/json';
      res.writeHead(upstream.status, { 'Content-Type': contentType });
      res.end(body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Upstream unreachable' }));
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Handle chat completion — balance mode (direct forward) or wallet mode (probe-pay-retry). */
  private async handleChatCompletion(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Read request body
    let bodyStr: string;
    try {
      bodyStr = await readBody(req, MAX_REQUEST_BODY_BYTES);
    } catch {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to read request body' }));
      }
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyStr);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    // Force n=1 on every forwarded request. The pricing probe returns a quote
    // for a single completion; accepting client-supplied n>1 would let callers
    // pay once and receive N responses ("pay-once, get-N" economic abuse).
    // Stripping here applies to probe, balance-mode forward, and paid-mode
    // forward via the `{...body}` spreads below. Per CLAUDE.md server rule.
    body.n = 1;

    // Balance mode: probe price for budget enforcement, then forward with Bearer auth
    if (this.balanceToken) {
      let priceSats = 0;

      // Probe to discover price so BudgetTracker can enforce limits
      const probeBody = { ...body, stream: false };
      const probeResult = await this.probe(probeBody);
      if (probeResult) {
        const probed = probeResult.body.cashu?.price_sats ?? probeResult.body.price;
        if (probed && Number.isFinite(probed) && probed > 0) {
          priceSats = probed;
          try {
            this.budget.reserve(priceSats);
          } catch (err) {
            if (err instanceof BudgetError) {
              res.writeHead(402, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
              return;
            }
            throw err;
          }
        }
      }

      const payment = { name: 'Authorization', value: `Bearer ${this.balanceToken}` };
      await this.sendPaidRequest(res, body, payment, priceSats);
      return;
    }

    // Wallet mode: probe-pay-retry
    if (!this.wallet) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No wallet or balance token configured' }));
      return;
    }

    // Preserve the client's stream preference for the paid request
    const wantsStream = body.stream === true;

    // Step 1: PROBE — send without payment, expect 402
    const probeBody = { ...body, stream: false }; // Probe is always non-streaming
    const probeResult = await this.probe(probeBody);

    if (!probeResult) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server did not require payment' }));
      return;
    }

    const challenge = probeResult.body;
    const priceSats = challenge.cashu?.price_sats ?? challenge.price;
    if (!priceSats || !Number.isFinite(priceSats) || priceSats <= 0) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server returned invalid price' }));
      return;
    }

    // Step 2: BUDGET RESERVE (atomic check + deduct to prevent race conditions)
    try {
      this.budget.reserve(priceSats);
    } catch (err) {
      if (err instanceof BudgetError) {
        res.writeHead(402, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      throw err;
    }

    // Step 3: PAY — try each payment method
    let paymentHeader: { name: string; value: string } | null = null;
    let cashuToken: string | null = null; // Track for recovery on send failure
    const errors: string[] = [];

    // Try Cashu
    try {
      const { token } = await this.wallet.selectProofs(priceSats);
      cashuToken = token;
      paymentHeader = { name: 'X-Cashu', value: token };
    } catch (err) {
      console.error(`[llm402-proxy] Cashu failed: ${redactSecrets(err)}`);
      errors.push('Cashu: payment_failed');
    }

    // Try x402 if Cashu failed — resolve from v2 header or legacy body.
    // CALLER owns the USDC cents reservation lifecycle (reserve BEFORE sign,
    // release on sign throw). signX402 is a pure signing function. This
    // prevents the "reserved inside signX402, outer scope never knew, never
    // released on throw" budget-leak bug.
    const x402Req = resolveX402Requirement(probeResult.envelope, challenge.x402);
    let x402CentsReserved = 0;
    if (!paymentHeader && x402Req) {
      try {
        const cents = this.usdcCentsFromAtomic(BigInt(x402Req.amount));
        if (cents > 0) {
          // Throws BudgetError if session exhausted — caught below
          this.budget.reserveUsdcCents(cents);
          x402CentsReserved = cents;
        }
        try {
          const x402Header = await this.signX402(x402Req);
          paymentHeader = { name: 'Payment-Signature', value: x402Header };
        } catch (signErr) {
          // Signing failed AFTER reserve — release and re-raise
          if (x402CentsReserved > 0) {
            this.budget.releaseUsdcCents(x402CentsReserved);
            x402CentsReserved = 0;
          }
          throw signErr;
        }
      } catch (err) {
        console.error(`[llm402-proxy] x402 failed: ${redactSecrets(err)}`);
        errors.push('x402: payment_failed');
      }
    }

    // Try L402 if both failed
    if (!paymentHeader && challenge.invoice && challenge.macaroon) {
      try {
        const { preimage } = await this.wallet.meltForInvoice(challenge.invoice);
        if (!preimage) {
          throw new Error('No preimage returned from mint');
        }
        paymentHeader = { name: 'Authorization', value: `L402 ${challenge.macaroon}:${preimage}` };
      } catch (err) {
        console.error(`[llm402-proxy] L402 failed: ${redactSecrets(err)}`);
        errors.push('L402: payment_failed');
      }
    }

    if (!paymentHeader) {
      // Release reserved budget — payment was never sent
      this.budget.release(priceSats);
      if (x402CentsReserved > 0) this.budget.releaseUsdcCents(x402CentsReserved);
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: `All payment methods failed. ${errors.join('. ')}`,
      }));
      return;
    }

    // Step 4: RETRY — send with payment header
    const paidBody = { ...body, stream: wantsStream };
    await this.sendPaidRequest(res, paidBody, paymentHeader, priceSats, cashuToken, x402CentsReserved);
  }

  /**
   * Convert USDC atomic (6-decimal) units to cents (2-decimal).
   * 1 USDC = 1_000_000 atomic = 100 cents → 1 cent = 10_000 atomic.
   * Truncates sub-cent amounts (floor); never negative.
   */
  private usdcCentsFromAtomic(atomic: bigint): number {
    if (atomic <= 0n) return 0;
    const cents = atomic / 10_000n;
    // Cap at Number.MAX_SAFE_INTEGER (absurd; MAX_USDC_PER_REQUEST_ATOMIC is $5)
    if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
    return Number(cents);
  }

  /** Probe: send without payment, get 402 challenge with v2 envelope. */
  private async probe(body: Record<string, unknown>): Promise<ProbeResult | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
      const upstream = await secureFetch(`${this.targetUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Stream probe response with 64KB cap (prevents memory exhaustion from malicious upstream)
      const text = await readResponseCapped(upstream, MAX_PROBE_RESPONSE_BYTES);

      if (upstream.status === 402) {
        const responseBody = JSON.parse(text) as PaymentRequiredResponse;
        const envelope = parsePaymentRequiredHeader(upstream.headers.get('payment-required'));
        return { body: responseBody, envelope };
      }

      if (upstream.ok) {
        return null; // No payment needed (shouldn't happen)
      }

      throw new Error(`Probe failed: ${upstream.status} ${text.slice(0, 200)}`);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error('Price probe timed out');
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Sign x402 USDC payment. Returns base64-encoded Payment-Signature header value. */
  private async signX402(requirement: X402PaymentRequirement): Promise<string> {
    if (!this.wallet) throw new Error('No wallet configured for x402');
    const evmKey = this.wallet.getEvmPrivateKey();
    if (!evmKey) throw new Error('No EVM key configured');

    // Validate server-provided values against pinned constants
    if (requirement.payTo?.toLowerCase() !== EXPECTED_PAYTO.toLowerCase()) {
      throw new Error('x402 payTo validation failed');
    }
    if (requirement.asset?.toLowerCase() !== USDC_ADDRESS.toLowerCase()) {
      throw new Error('x402 asset validation failed');
    }
    if (requirement.network !== EXPECTED_NETWORK) {
      throw new Error('x402 network validation failed');
    }

    // Dynamic import — viem is 53MB, only load for x402 mode
    const { createWalletClient, http, getAddress } = await import('viem');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { base } = await import('viem/chains');
    const { randomBytes } = await import('crypto');

    // Use pre-calculated atomic amount from v2 header (or converted from legacy body)
    const amountAtomic = BigInt(requirement.amount);
    if (amountAtomic <= 0n) {
      throw new Error(`x402 amount must be positive, got ${requirement.amount}`);
    }
    // Absolute USDC cap per request — independent of server-provided sats.
    // Cannot be bypassed. $5 = 5_000_000 atomic USDC.
    if (amountAtomic > MAX_USDC_PER_REQUEST_ATOMIC) {
      throw new Error(`x402 amount exceeds per-request USDC cap`);
    }

    // NOTE: session USDC cents reservation is handled by the CALLER in
    // handleChatCompletion. signX402 is pure signing. Do not reserve here.

    const account = privateKeyToAccount(evmKey as `0x${string}`);
    const walletClient = createWalletClient({
      account,
      chain: base,
      // Resolver rejects any LLM402_BASE_RPC_URL_OVERRIDE not in the Base-mainnet
      // allowlist. Prevents co-resident plugins from setting an attacker RPC via env.
      transport: http(resolveBaseRpcUrl()),
    });

    const now = Math.floor(Date.now() / 1000);
    const nonce = ('0x' + randomBytes(32).toString('hex')) as `0x${string}`;
    const payTo = getAddress(requirement.payTo);

    // EIP-712 domain is HARDCODED (consensus: pentester + skeptic — server-provided
    // extra.name/version is a DoS vector with zero benefit since USDC domain is immutable)
    const signature = await walletClient.signTypedData({
      domain: {
        name: USDC_EIP712_DOMAIN.name,
        version: USDC_EIP712_DOMAIN.version,
        chainId: 8453,
        verifyingContract: USDC_ADDRESS as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: getAddress(account.address),
        to: payTo,
        value: amountAtomic,
        validAfter: BigInt(now - 60), // Tightened from 600s per audit
        validBefore: BigInt(now + 120),
        nonce,
      },
    });

    const payload = {
      x402Version: 2,
      resource: {
        url: `${this.targetUrl}/v1/chat/completions`,
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

    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

  /** Send paid request and pipe response back to OpenClaw. */
  private async sendPaidRequest(
    res: ServerResponse,
    body: Record<string, unknown>,
    payment: { name: string; value: string },
    priceSats: number,
    cashuToken?: string | null,
    usdcCentsReserved: number = 0,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);

    // Abort upstream fetch if client disconnects (prevents wasting bandwidth)
    res.on('close', () => controller.abort());

    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        [payment.name]: payment.value,
      };

      // For Cashu non-streaming, force stream:false (server blocks streaming with X-Cashu)
      if (payment.name === 'X-Cashu') {
        body.stream = false;
      }

      const upstream = await secureFetch(`${this.targetUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Recover Cashu change tokens if present (on success OR error — server may refund)
      const changeHeader = upstream.headers.get('X-Cashu-Change') || upstream.headers.get('x-cashu-change');
      if (changeHeader && this.wallet) {
        this.wallet.addChangeProofs(changeHeader).catch((err) => {
          console.error(`[llm402-proxy] Failed to recover change: ${redactSecrets(err)}`);
        });
      }

      if (!upstream.ok) {
        const text = await readResponseCapped(upstream, MAX_PROBE_RESPONSE_BYTES);
        let errorMsg = 'Payment accepted but inference failed';
        try {
          const errJson = JSON.parse(text);
          errorMsg = typeof errJson.error === 'string' ? errJson.error : errorMsg;
        } catch { /* use default */ }
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: errorMsg }));
        return;
      }

      // Budget was already reserved upfront via budget.reserve().
      // On success (here), we keep the reservation — the spend is confirmed.
      // On failure (!upstream.ok above), the spend is still kept because payment
      // may have been consumed by the server (Cashu proofs burned, LN paid).
      // Only the "all payment methods failed" path releases the budget.

      // Pipe the response through — works for both streaming (SSE) and non-streaming (JSON)
      const contentType = upstream.headers.get('content-type') || 'application/json';
      res.writeHead(200, { 'Content-Type': contentType });

      if (upstream.body) {
        // Stream the response body
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } catch (err) {
          // Client disconnected or upstream error — clean up
          console.error(`[llm402-proxy] Stream error: ${redactSecrets(err)}`);
        } finally {
          res.end();
        }
      } else {
        // Fallback: body is null (extremely rare with fetch). Cap to prevent memory exhaustion.
        const text = await readResponseCapped(upstream, MAX_CATALOG_RESPONSE_BYTES);
        res.end(text);
      }
    } catch (err) {
      // Attempt Cashu proof recovery if the request never reached the server
      // (network error, timeout, DNS failure). The token proofs may still be
      // valid at the mint if the server never saw them.
      if (cashuToken && this.wallet) {
        try {
          await this.wallet.addChangeProofs(cashuToken);
          console.error('[llm402-proxy] Recovered Cashu proofs after send failure');
        } catch (recoverErr) {
          console.error(`[llm402-proxy] Cashu proof recovery failed: ${redactSecrets(recoverErr)}`);
        }
      }

      // Release USDC cents reservation if the request never reached the server.
      // If the request WAS sent and server returned error, reservation stays
      // (we cannot know if the server burned the x402 nonce — assume consumed).
      if (usdcCentsReserved > 0 && err instanceof Error && err.name === 'AbortError') {
        // Fetch was aborted — safe to assume nonce not burned at server
        this.budget.releaseUsdcCents(usdcCentsReserved);
      }

      if (err instanceof Error && err.name === 'AbortError') {
        if (!res.headersSent) {
          res.writeHead(504, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Inference request timed out' }));
        }
        return;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Read request body with size limit. */
function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let rejected = false;

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > maxBytes && !rejected) {
        rejected = true;
        req.destroy(new Error('Request body too large'));
        reject(new Error('Request body too large'));
        return;
      }
      if (!rejected) chunks.push(chunk);
    });

    req.on('end', () => { if (!rejected) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', (err) => { if (!rejected) { rejected = true; reject(err); } });
  });
}
