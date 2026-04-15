/**
 * Llm402Wallet — Cashu ecash + EVM wallet for llm402.ai MCP server
 *
 * Uses @cashu/cashu-ts directly for proof management.
 * Uses nostr-tools for NIP-60 wallet sync (encrypted wallet state on Nostr relays).
 * Uses viem for EVM key management (x402 USDC payments on Base).
 * Persists locally to ~/.llm402/wallet.json as primary storage.
 *
 * Security invariants:
 * - nsec NEVER logged, NEVER sent to any server (only used for Nostr signing)
 * - evmPrivateKey NEVER logged, NEVER sent to any server (only used for local EIP-712 signing)
 * - Proofs are real money — atomic operations, no partial state
 * - Fail-closed on all errors
 */

import { Wallet, getTokenMetadata, getEncodedTokenV4, MintQuoteState } from '@cashu/cashu-ts';
import type { Proof, MintQuoteBolt11Response } from '@cashu/cashu-ts';
import { generateSecretKey, getPublicKey, nip19, finalizeEvent, nip44, verifyEvent } from 'nostr-tools';
import type { EventTemplate } from 'nostr-tools';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { WalletData, WalletDataV1, WalletDataV2, SerializedProof, MintBalance, BalanceSummary, FundingResult } from './types.js';

// Validates mint URL: HTTPS only, no private/reserved IPs, no localhost.
export function validateMintUrl(mintUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(mintUrl);
  } catch {
    throw new Error('Invalid mint URL');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Mint URL must use HTTPS');
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost variants
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
    throw new Error('Mint URL cannot point to localhost');
  }

  // Block private/reserved IP ranges (IPv4)
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, aStr, bStr] = ipv4Match;
    const a = Number(aStr);
    const b = Number(bStr);
    if (a === 10) throw new Error('Mint URL cannot point to private network');
    if (a === 172 && b >= 16 && b <= 31) throw new Error('Mint URL cannot point to private network');
    if (a === 192 && b === 168) throw new Error('Mint URL cannot point to private network');
    if (a === 169 && b === 254) throw new Error('Mint URL cannot point to link-local address');
    if (a === 0) throw new Error('Mint URL cannot point to reserved address');
    if (a === 127) throw new Error('Mint URL cannot point to loopback');
  }

  // Block IPv6 private ranges in brackets
  if (hostname.startsWith('[')) {
    const inner = hostname.slice(1, -1).toLowerCase();
    if (inner.startsWith('fc') || inner.startsWith('fd') || inner.startsWith('fe80')) {
      throw new Error('Mint URL cannot point to private IPv6 address');
    }
  }

  return parsed.toString().replace(/\/$/, '');
}

/**
 * Validate a Nostr relay URL. Must be wss://, not localhost/private IP.
 * Returns the normalized URL or throws.
 */
export function validateRelayUrl(relayUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(relayUrl);
  } catch {
    throw new Error('Invalid relay URL');
  }

  if (parsed.protocol !== 'wss:') {
    throw new Error('Relay URL must use wss://');
  }

  const hostname = parsed.hostname.toLowerCase();

  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]') {
    throw new Error('Relay URL cannot point to localhost');
  }

  if (hostname.endsWith('.local') || hostname.endsWith('.lan')) {
    throw new Error('Relay URL cannot point to local network');
  }

  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127) {
      throw new Error('Relay URL cannot point to private network');
    }
  }

  if (hostname.startsWith('[')) {
    const inner = hostname.slice(1, -1).toLowerCase();
    if (inner.startsWith('fc') || inner.startsWith('fd') || inner.startsWith('fe80')) {
      throw new Error('Relay URL cannot point to private IPv6 address');
    }
  }

  return parsed.toString().replace(/\/$/, '');
}

// --- Default configuration ---
const DEFAULT_MINTS = [
  'https://mint.minibits.cash/Bitcoin',
  'https://mint.lnvoltz.com',
];

const NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

// NIP-60 event kind for wallet state
const NIP60_WALLET_KIND = 37375;

const WALLET_DIR = join(homedir(), '.llm402');
const WALLET_FILE = join(WALLET_DIR, 'wallet.json');

// Timeout for mint operations (ms)
const MINT_TIMEOUT = 15_000;

// Average cost per request in sats (rough estimate for "estimated requests remaining")
const AVG_REQUEST_COST_SATS = 21;

export class Llm402Wallet {
  private proofs: Map<string, Proof[]> = new Map(); // mintUrl -> proofs
  private wallets: Map<string, Wallet> = new Map(); // mintUrl -> CashuWallet instance
  private secretKey: Uint8Array | null = null;
  private npub: string = '';
  private nsec: string = '';
  private evmPrivateKey: string = '';  // 0x-prefixed hex — NEVER log or send
  private evmAddress: string = '';     // 0x-prefixed checksummed
  private mintUrls: string[] = [];
  private initialized = false;
  // Mutex for proof operations — prevents concurrent selectProofs/meltForInvoice
  // from racing on the same proof set (double-spend/proof-loss prevention).
  private proofLock: Promise<void> = Promise.resolve();
  private acquireProofLock(): Promise<() => void> {
    let release!: () => void;
    const prev = this.proofLock;
    this.proofLock = new Promise<void>(resolve => { release = resolve; });
    return prev.then(() => release);
  }

  /**
   * Initialize wallet — load from disk or create new.
   * @param nsec Optional Nostr secret key (bech32). If omitted, generates new or loads from disk.
   * @param evmKey Optional EVM private key (0x hex). If omitted, generates new or loads from disk.
   */
  async init(nsec?: string, evmKey?: string): Promise<void> {
    // Try loading existing wallet from disk
    const existing = this.loadFromDisk();

    if (existing && !nsec) {
      // Use existing wallet
      this.nsec = existing.nsec;
      this.npub = existing.npub;
      this.mintUrls = existing.mints;
      this.secretKey = nip19.decode(existing.nsec).data as Uint8Array;

      // Restore proofs
      for (const [mintUrl, serialized] of Object.entries(existing.proofs)) {
        this.proofs.set(mintUrl, serialized.map(s => ({
          id: s.id,
          amount: s.amount,
          secret: s.secret,
          C: s.C,
        } as Proof)));
      }

      // EVM key: load from v2 or migrate from v1
      if (existing.version === 2) {
        this.evmPrivateKey = evmKey || existing.evmPrivateKey;
        this.evmAddress = evmKey
          ? privateKeyToAccount(evmKey as `0x${string}`).address
          : existing.evmAddress;
      } else {
        // v1 → v2 migration: generate EVM key
        this.generateEvmKey(evmKey);
        console.error('[wallet] Migrated wallet v1 → v2 with EVM support.');
      }
    } else if (nsec) {
      // Use provided nsec
      this.nsec = nsec;
      this.secretKey = nip19.decode(nsec).data as Uint8Array;
      this.npub = nip19.npubEncode(getPublicKey(this.secretKey));
      this.mintUrls = existing?.mints || [...DEFAULT_MINTS];

      // If existing wallet had proofs and same nsec, keep them
      if (existing && existing.nsec === nsec) {
        for (const [mintUrl, serialized] of Object.entries(existing.proofs)) {
          this.proofs.set(mintUrl, serialized.map(s => ({
            id: s.id,
            amount: s.amount,
            secret: s.secret,
            C: s.C,
          } as Proof)));
        }
      }

      // EVM key: use provided, or from existing v2, or generate new
      if (evmKey) {
        this.generateEvmKey(evmKey);
      } else if (existing?.version === 2 && existing.nsec === nsec) {
        this.evmPrivateKey = existing.evmPrivateKey;
        this.evmAddress = existing.evmAddress;
      } else {
        this.generateEvmKey();
      }
    } else {
      // Generate new keypair (both Nostr + EVM)
      this.secretKey = generateSecretKey();
      this.nsec = nip19.nsecEncode(this.secretKey);
      this.npub = nip19.npubEncode(getPublicKey(this.secretKey));
      this.mintUrls = [...DEFAULT_MINTS];
      this.generateEvmKey(evmKey);
    }

    // Connect to mints
    await this.connectMints(this.mintUrls);

    this.initialized = true;

    // Save state (always v2 now)
    await this.save();
  }

  /**
   * Generate or import an EVM private key.
   */
  private generateEvmKey(importKey?: string): void {
    if (importKey) {
      const account = privateKeyToAccount(importKey as `0x${string}`);
      this.evmPrivateKey = importKey;
      this.evmAddress = account.address;
    } else {
      const pk = generatePrivateKey();
      const account = privateKeyToAccount(pk);
      this.evmPrivateKey = pk;
      this.evmAddress = account.address;
    }
  }

  /**
   * Connect to mint URLs and initialize wallet instances.
   */
  async connectMints(mintUrls: string[]): Promise<void> {
    const results = await Promise.allSettled(
      mintUrls.map(async (url) => {
        if (this.wallets.has(url)) return;
        try {
          // SSRF protection: validate URL before making any network request
          validateMintUrl(url);
          const wallet = new Wallet(url, { unit: 'sat' });
          await withTimeout(wallet.loadMint(), MINT_TIMEOUT, `loadMint(${url})`);
          this.wallets.set(url, wallet);
          if (!this.proofs.has(url)) {
            this.proofs.set(url, []);
          }
        } catch (err) {
          console.error(`[wallet] Failed to connect to mint ${url}: ${err instanceof Error ? err.message : err}`);
          // Non-fatal — we may have other mints
        }
      })
    );

    const connected = results.filter(r => r.status === 'fulfilled').length;
    if (connected === 0 && mintUrls.length > 0) {
      console.error('[wallet] WARNING: Could not connect to any mint');
    }
  }

  /**
   * Select proofs for a payment of the given amount.
   * Uses coin selection: picks from the mint with the highest balance that can cover the amount.
   * Splits proofs if needed (via mint swap) to get exact change.
   *
   * Returns the mint URL, selected proofs, and an encoded Cashu token string.
   */
  async selectProofs(amountSats: number): Promise<{ mintUrl: string; proofs: Proof[]; token: string }> {
    this.ensureInit();
    const release = await this.acquireProofLock();
    try { return await this._selectProofsImpl(amountSats); } finally { release(); }
  }

  private async _selectProofsImpl(amountSats: number): Promise<{ mintUrl: string; proofs: Proof[]; token: string }> {
    if (amountSats <= 0) {
      throw new Error('Amount must be positive');
    }

    // Sort mints by balance (highest first)
    const mintBalances = this.getMintBalances();
    mintBalances.sort((a, b) => b.sats - a.sats);

    for (const { url, sats } of mintBalances) {
      if (sats < amountSats) continue;

      const wallet = this.wallets.get(url);
      if (!wallet) continue;

      const mintProofs = this.proofs.get(url) || [];

      try {
        // Use cashu-ts send() for coin selection + optional splitting
        const { keep, send } = await withTimeout(
          wallet.send(amountSats, mintProofs, { includeFees: true }),
          MINT_TIMEOUT,
          'send (coin selection)'
        );

        // Update stored proofs: keep the change, remove the sent ones
        this.proofs.set(url, keep);

        // Encode selected proofs as a Cashu token
        const token = getEncodedTokenV4({ mint: url, proofs: send, unit: 'sat' });

        await this.save();
        return { mintUrl: url, proofs: send, token };
      } catch (err) {
        console.error(`[wallet] Coin selection failed at ${url}: ${err instanceof Error ? err.message : err}`);
        // Try next mint
        continue;
      }
    }

    const total = this.getTotal();
    throw new Error(
      `Insufficient funds: need ${amountSats} sats, have ${total} sats total. ` +
      `Fund your wallet with: llm402_fund`
    );
  }

  /**
   * Add received change proofs back to the wallet.
   * Used when the server returns change tokens (future feature).
   */
  async addChangeProofs(encodedToken: string): Promise<void> {
    this.ensureInit();

    // Use getTokenMetadata instead of getDecodedToken because cashuB (v4) tokens
    // truncate keyset IDs to 8 bytes. getDecodedToken can't resolve these short IDs
    // without a keyset list, but getTokenMetadata skips keyset ID resolution entirely.
    const meta = getTokenMetadata(encodedToken);
    if (!meta || !meta.incompleteProofs || meta.incompleteProofs.length === 0) return;

    const mintUrl = meta.mint;
    if (!mintUrl) return;

    // SSRF protection: validate mint URL before connecting (change tokens come from server response)
    try {
      validateMintUrl(mintUrl);
    } catch (err) {
      console.error(`[wallet] Rejecting change token with invalid mint URL: ${err instanceof Error ? err.message : err}`);
      return;
    }

    // Only accept change from mints we already know — prevents attacker-controlled mints
    // from polluting the wallet with worthless proofs or tracking the user's IP
    if (!this.mintUrls.includes(mintUrl) && !this.wallets.has(mintUrl)) {
      console.error(`[wallet] Rejecting change token from unknown mint: ${mintUrl}`);
      return;
    }

    // Ensure we have a wallet connection for this mint
    if (!this.wallets.has(mintUrl)) {
      await this.connectMints([mintUrl]);
    }

    const wallet = this.wallets.get(mintUrl);
    if (!wallet) {
      console.error(`[wallet] Cannot add change: no connection to mint ${mintUrl}`);
      return;
    }

    // Receive tokens (swap at mint to claim them)
    // Acquire proofLock — addChangeProofs modifies this.proofs which races with selectProofs/meltForInvoice
    const release = await this.acquireProofLock();
    try {
      const receivedProofs = await withTimeout(
        wallet.receive(encodedToken),
        MINT_TIMEOUT,
        'receive change'
      );

      const existing = this.proofs.get(mintUrl) || [];
      this.proofs.set(mintUrl, [...existing, ...receivedProofs]);
      await this.save();
    } catch (err) {
      console.error(`[wallet] Failed to receive change tokens: ${err instanceof Error ? err.message : err}`);
    } finally {
      release();
    }
  }

  /**
   * Request a Lightning invoice for funding the wallet.
   */
  async requestFunding(amountSats: number, mintUrl?: string): Promise<FundingResult> {
    this.ensureInit();

    // Pick mint: specified, or first connected mint
    const url = mintUrl || this.getPreferredMint();
    if (!url) {
      throw new Error('No connected mints. Try again later or specify a mint URL.');
    }

    const wallet = this.wallets.get(url);
    if (!wallet) {
      throw new Error(`Not connected to mint ${url}`);
    }

    // Create mint quote (Lightning invoice)
    const quote: MintQuoteBolt11Response = await withTimeout(
      wallet.createMintQuoteBolt11(amountSats),
      MINT_TIMEOUT,
      'createMintQuoteBolt11'
    );

    return {
      invoice: quote.request,
      quoteId: quote.quote,
      mintUrl: url,
      amountSats,
    };
  }

  /**
   * Check if a funding quote has been paid and mint tokens if so.
   * Returns 'paid' if tokens were minted, 'expired' if the quote no longer
   * exists at the mint, or 'unpaid' if still waiting for payment.
   */
  async checkFunding(quoteId: string, mintUrl: string, amountSats?: number): Promise<'paid' | 'expired' | 'unpaid'> {
    this.ensureInit();

    const wallet = this.wallets.get(mintUrl);
    if (!wallet) {
      throw new Error(`Not connected to mint ${mintUrl}`);
    }

    try {
      const quote = await withTimeout(
        wallet.checkMintQuoteBolt11(quoteId),
        MINT_TIMEOUT,
        'checkMintQuoteBolt11'
      );

      if (quote.state === MintQuoteState.PAID || quote.state === MintQuoteState.ISSUED) {
        const mintAmount = (quote as Record<string, unknown>).amount as number || amountSats || 0;
        if (!mintAmount) {
          throw new Error('Cannot mint: amount unknown');
        }

        const proofs = await withTimeout(
          wallet.mintProofsBolt11(mintAmount, quoteId),
          MINT_TIMEOUT,
          'mintProofsBolt11'
        );

        const existing = this.proofs.get(mintUrl) || [];
        this.proofs.set(mintUrl, [...existing, ...proofs]);
        await this.save();

        this.syncToNostr().catch(err => {
          console.error(`[wallet] Nostr sync failed: ${err instanceof Error ? err.message : err}`);
        });

        return 'paid';
      }

      return 'unpaid';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Mints return 404 or "not found" when a quote has expired/been garbage-collected
      if (/not.?found|404|unknown.*quote|expired/i.test(msg)) {
        return 'expired';
      }
      console.error(`[wallet] checkFunding error: ${msg}`);
      return 'unpaid';
    }
  }

  /**
   * Melt Cashu tokens to pay a Lightning invoice (L402 fallback).
   * Returns the preimage from the payment.
   */
  async meltForInvoice(invoice: string): Promise<{ preimage: string }> {
    this.ensureInit();
    const release = await this.acquireProofLock();
    try { return await this._meltForInvoiceImpl(invoice); } finally { release(); }
  }

  private async _meltForInvoiceImpl(invoice: string): Promise<{ preimage: string }> {
    // Try each mint in order of balance
    const mintBalances = this.getMintBalances();
    mintBalances.sort((a, b) => b.sats - a.sats);

    for (const { url } of mintBalances) {
      const wallet = this.wallets.get(url);
      if (!wallet) continue;

      const mintProofs = this.proofs.get(url) || [];
      if (mintProofs.length === 0) continue;

      try {
        // Get melt quote to know the cost
        const meltQuote = await withTimeout(
          wallet.createMeltQuoteBolt11(invoice),
          MINT_TIMEOUT,
          'createMeltQuoteBolt11'
        );

        const totalNeeded = meltQuote.amount + meltQuote.fee_reserve;

        // Select proofs for the melt
        const { keep, send } = await withTimeout(
          wallet.send(totalNeeded, mintProofs, { includeFees: true }),
          MINT_TIMEOUT,
          'send (for melt)'
        );

        // Execute the melt (pay the LN invoice)
        const meltResult = await withTimeout(
          wallet.meltProofsBolt11(meltQuote, send),
          30_000, // longer timeout for LN payment
          'meltProofsBolt11'
        );

        // Update proofs: keep change + any returned change from melt
        const changeProofs = meltResult.change || [];
        this.proofs.set(url, [...keep, ...changeProofs]);
        await this.save();

        // Get preimage — check meltResult first (some cashu-ts versions include it),
        // then fall back to checkMeltQuoteBolt11. Log the quote ID so manual recovery
        // is possible if preimage is unavailable.
        let preimage = '';

        // Try 1: preimage on the quote object inside melt result (typed path for cashu-ts v3.6+)
        const quoteResult = (meltResult as { quote?: { payment_preimage?: string | null } }).quote;
        const resultPreimage = quoteResult?.payment_preimage;
        if (resultPreimage && typeof resultPreimage === 'string' && resultPreimage.length > 0) {
          preimage = resultPreimage;
        }

        // Try 2: check melt quote status (mint may have it even if meltResult didn't)
        if (!preimage) {
          try {
            const checkedQuote = await withTimeout(
              wallet.checkMeltQuoteBolt11(meltQuote.quote),
              MINT_TIMEOUT,
              'checkMeltQuoteBolt11'
            );
            const quotePreimage = (checkedQuote as Record<string, unknown>).payment_preimage as string;
            if (quotePreimage && typeof quotePreimage === 'string' && quotePreimage.length > 0) {
              preimage = quotePreimage;
            }
          } catch {
            // Mint may not support this — fall through
          }
        }

        if (!preimage) {
          console.error(`[wallet] WARNING: Melt succeeded at ${url} but no preimage returned. Quote ID: ${meltQuote.quote}. Sats may be unrecoverable for L402.`);
        }

        return { preimage };
      } catch (err) {
        console.error(`[wallet] Melt failed at ${url}: ${err instanceof Error ? err.message : err}`);
        continue;
      }
    }

    throw new Error('Failed to pay Lightning invoice: no mint could complete the payment');
  }

  /**
   * Get balance summary.
   */
  getBalance(): BalanceSummary {
    const perMint = this.getMintBalances();
    const total = perMint.reduce((sum, m) => sum + m.sats, 0);

    return {
      total,
      perMint,
      estimatedRequests: Math.floor(total / AVG_REQUEST_COST_SATS),
    };
  }

  /**
   * Get the nsec for display during init (never log this in production).
   */
  getNsec(): string {
    return this.nsec;
  }

  /**
   * Get the npub for display.
   */
  getNpub(): string {
    return this.npub;
  }

  /**
   * Get connected mint URLs.
   */
  getMintUrls(): string[] {
    return [...this.mintUrls];
  }

  /**
   * Get the EVM wallet address (checksummed).
   */
  getEvmAddress(): string {
    return this.evmAddress;
  }

  /**
   * Get the EVM private key for local signing. NEVER log or send this.
   */
  getEvmPrivateKey(): string {
    this.ensureInit();
    return this.evmPrivateKey;
  }

  /**
   * Check if wallet has been initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  // --- Persistence ---

  /**
   * Save wallet state to ~/.llm402/wallet.json (always v2)
   */
  async save(): Promise<void> {
    const data: WalletDataV2 = {
      version: 2,
      nsec: this.nsec,
      npub: this.npub,
      evmPrivateKey: this.evmPrivateKey,
      evmAddress: this.evmAddress,
      mints: this.mintUrls,
      proofs: {},
      createdAt: new Date().toISOString(),
      lastSyncAt: null,
    };

    for (const [mintUrl, proofs] of this.proofs) {
      data.proofs[mintUrl] = proofs.map(p => ({
        id: p.id,
        amount: p.amount,
        secret: p.secret,
        C: p.C,
      }));
    }

    try {
      if (!existsSync(WALLET_DIR)) {
        mkdirSync(WALLET_DIR, { recursive: true, mode: 0o700 });
      }
      // Atomic write: write to .tmp then rename (POSIX guarantees atomicity).
      // Prevents data loss if process is killed mid-write.
      const tmpFile = WALLET_FILE + '.tmp';
      writeFileSync(tmpFile, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmpFile, WALLET_FILE);
    } catch (err) {
      console.error(`[wallet] Failed to save: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Load wallet from disk. Accepts v1 or v2.
   */
  private loadFromDisk(): WalletData | null {
    try {
      if (!existsSync(WALLET_FILE)) return null;
      const raw = readFileSync(WALLET_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data.version !== 1 && data.version !== 2) {
        console.error('[wallet] Unknown wallet version, ignoring');
        return null;
      }
      return data as WalletData;
    } catch (err) {
      console.error(`[wallet] Failed to load: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  // --- NIP-60 Nostr Sync ---

  /**
   * Sync wallet state to Nostr relays (encrypted with NIP-44).
   * Publishes wallet proofs as a replaceable event (kind 37375).
   */
  async syncToNostr(): Promise<void> {
    if (!this.secretKey) return;

    try {
      // Serialize proof state
      const proofData: Record<string, SerializedProof[]> = {};
      for (const [mintUrl, proofs] of this.proofs) {
        proofData[mintUrl] = proofs.map(p => ({
          id: p.id,
          amount: p.amount,
          secret: p.secret,
          C: p.C,
        }));
      }

      const payload = JSON.stringify({
        version: 1,
        mints: this.mintUrls,
        proofs: proofData,
        updatedAt: new Date().toISOString(),
      });

      // Encrypt with NIP-44 (self-encrypt: encrypt to own pubkey)
      const pubkey = getPublicKey(this.secretKey);
      const conversationKey = nip44.v2.utils.getConversationKey(this.secretKey, pubkey);
      const encrypted = nip44.v2.encrypt(payload, conversationKey);

      // Build NIP-60 event (replaceable parameterized: kind 37375, d-tag = "llm402")
      const eventTemplate: EventTemplate = {
        kind: NIP60_WALLET_KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'llm402-wallet'],
          ['encrypted', 'nip44'],
        ],
        content: encrypted,
      };

      const signedEvent = finalizeEvent(eventTemplate, this.secretKey);

      // Publish to relays
      await publishToRelays(signedEvent, NOSTR_RELAYS);

      console.error('[wallet] Synced to Nostr relays');
    } catch (err) {
      console.error(`[wallet] Nostr sync failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Sync wallet state from Nostr relays.
   * Looks for NIP-60 wallet event and decrypts.
   */
  async syncFromNostr(opts?: {
    relays?: string[];
    allowRemoteMints?: boolean;
  }): Promise<{ events: number; proofsAdded: number; sats: number }> {
    const result = { events: 0, proofsAdded: 0, sats: 0 };
    if (!this.secretKey) return result;

    // Validate + cap custom relays if provided
    const relayUrls = opts?.relays
      ? opts.relays.slice(0, 10).map(url => validateRelayUrl(url))
      : NOSTR_RELAYS;
    const allowRemoteMints = opts?.allowRemoteMints ?? false;

    try {
      const pubkey = getPublicKey(this.secretKey);

      // Dual d-tag read: covers both current and pre-rebrand wallet events
      const event = await fetchFromRelays(
        {
          kinds: [NIP60_WALLET_KIND],
          authors: [pubkey],
          '#d': ['llm402-wallet', 'bestpath-wallet'],
          limit: 32,
        },
        relayUrls
      );

      if (!event) return result;

      if (!verifyEvent(event)) {
        console.error('[wallet] Nostr sync: event verification failed, rejecting');
        return result;
      }
      if (event.pubkey !== pubkey) {
        console.error('[wallet] Nostr sync: event pubkey mismatch, rejecting');
        return result;
      }

      result.events = 1;

      // Decrypt event content
      let data: Record<string, unknown>;
      try {
        const conversationKey = nip44.v2.utils.getConversationKey(this.secretKey, pubkey);
        const decrypted = nip44.v2.decrypt(event.content, conversationKey);
        data = JSON.parse(decrypted);
      } catch (err) {
        console.error(`[wallet] Nostr sync: decrypt failed for event ${event.id.slice(0, 8)}, skipping`);
        return result;
      }

      if (data.version !== 1) return result;

      // Merge remote proofs
      const knownMints = new Set(this.mintUrls);
      for (const [mintUrl, remoteProofs] of Object.entries(data.proofs as Record<string, SerializedProof[]>)) {
        try {
          validateMintUrl(mintUrl);
        } catch {
          console.error(`[wallet] Skipping remote proofs from invalid mint: ${mintUrl}`);
          continue;
        }

        // Skip proofs from unknown mints unless explicitly allowed
        if (!knownMints.has(mintUrl) && !allowRemoteMints) {
          console.error(`[wallet] Skipping proofs from unknown mint (use --allow-remote-mints to include): ${mintUrl}`);
          continue;
        }

        const local = this.proofs.get(mintUrl) || [];
        const localSecrets = new Set(local.map(p => p.secret));

        for (const rp of remoteProofs) {
          if (!localSecrets.has(rp.secret)) {
            local.push({
              id: rp.id,
              amount: rp.amount,
              secret: rp.secret,
              C: rp.C,
            } as Proof);
            result.proofsAdded++;
            result.sats += rp.amount;
          }
        }
        this.proofs.set(mintUrl, local);
      }

      // Add new mints from remote data if allowed
      for (const mint of ((data.mints || []) as string[])) {
        if (!this.mintUrls.includes(mint)) {
          if (!allowRemoteMints) {
            console.error(`[wallet] Skipping unknown remote mint (use --allow-remote-mints): ${mint}`);
            continue;
          }
          try {
            validateMintUrl(mint);
            this.mintUrls.push(mint);
          } catch {
            console.error(`[wallet] Skipping invalid remote mint URL: ${mint}`);
          }
        }
      }

      if (result.proofsAdded > 0) {
        await this.save();
      }

      return result;
    } catch (err) {
      console.error(`[wallet] Nostr fetch failed: ${err instanceof Error ? err.message : err}`);
      return result;
    }
  }

  // --- Internal helpers ---

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error('Wallet not initialized. Call init() first.');
    }
  }

  private getMintBalances(): MintBalance[] {
    const balances: MintBalance[] = [];
    for (const [url, proofs] of this.proofs) {
      const sats = proofs.reduce((sum, p) => sum + p.amount, 0);
      balances.push({ url, sats });
    }
    return balances;
  }

  private getTotal(): number {
    let total = 0;
    for (const proofs of this.proofs.values()) {
      total += proofs.reduce((sum, p) => sum + p.amount, 0);
    }
    return total;
  }

  private getPreferredMint(): string | null {
    // Return first connected mint (prefer mints with existing balance)
    const balances = this.getMintBalances().sort((a, b) => b.sats - a.sats);
    for (const { url } of balances) {
      if (this.wallets.has(url)) return url;
    }
    // Fallback: any connected mint
    for (const url of this.wallets.keys()) {
      return url;
    }
    return null;
  }
}

// --- Utility functions ---

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.then(
      (v) => { clearTimeout(timer); return v; },
      (e) => { clearTimeout(timer); throw e; },
    ),
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/**
 * Publish a signed Nostr event to multiple relays.
 */
async function publishToRelays(event: ReturnType<typeof finalizeEvent>, relayUrls: string[]): Promise<void> {
  const promises = relayUrls.map(async (url) => {
    try {
      // Use WebSocket to publish
      const ws = await connectWebSocket(url, 5000);

      return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error(`Publish to ${url} timed out`));
        }, 10_000);

        ws.onmessage = (msg: MessageEvent) => {
          try {
            const data = JSON.parse(String(msg.data));
            if (data[0] === 'OK') {
              clearTimeout(timeout);
              ws.close();
              resolve();
            }
          } catch { /* ignore parse errors */ }
        };

        ws.onerror = () => {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(`WebSocket error on ${url}`));
        };

        ws.send(JSON.stringify(['EVENT', event]));
      });
    } catch (err) {
      // Non-fatal per relay
      console.error(`[nostr] Failed to publish to ${url}: ${err instanceof Error ? err.message : err}`);
    }
  });

  await Promise.allSettled(promises);
}

/**
 * Fetch a single event from relays matching a filter.
 */
async function fetchFromRelays(
  filter: Record<string, unknown>,
  relayUrls: string[]
): Promise<{ id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string } | null> {
  // Race: first relay to return an event wins
  return new Promise((resolve) => {
    let resolved = false;
    let completed = 0;

    const tryResolve = (event: { id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string } | null) => {
      if (resolved) return;
      if (event) {
        resolved = true;
        resolve(event);
      } else {
        completed++;
        if (completed >= relayUrls.length) {
          resolve(null);
        }
      }
    };

    for (const url of relayUrls) {
      (async () => {
        try {
          const ws = await connectWebSocket(url, 5000);
          const subId = `llm402-${Date.now()}`;

          const timeout = setTimeout(() => {
            ws.close();
            tryResolve(null);
          }, 10_000);

          ws.onmessage = (msg: MessageEvent) => {
            try {
              const data = JSON.parse(String(msg.data));
              if (data[0] === 'EVENT' && data[1] === subId && data[2]) {
                clearTimeout(timeout);
                ws.close();
                tryResolve(data[2]);
              } else if (data[0] === 'EOSE' && data[1] === subId) {
                clearTimeout(timeout);
                ws.close();
                tryResolve(null);
              }
            } catch { /* ignore */ }
          };

          ws.onerror = () => {
            clearTimeout(timeout);
            ws.close();
            tryResolve(null);
          };

          ws.send(JSON.stringify(['REQ', subId, filter]));
        } catch {
          tryResolve(null);
        }
      })();
    }
  });
}

/**
 * Connect to a WebSocket with a timeout.
 */
function connectWebSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error(`WebSocket connection to ${url} timed out`));
    }, timeoutMs);

    ws.onopen = () => {
      clearTimeout(timeout);
      resolve(ws);
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket connection to ${url} failed`));
    };
  });
}
