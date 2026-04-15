/**
 * Budget tracker — enforces per-request and session spending limits
 * across TWO accounting rails: sats (for Lightning/Cashu/balance) and
 * USDC cents (for x402).
 *
 * Sats and USDC cents are tracked separately because they're denominated
 * in different assets and the BTC/USD rate fluctuates. Trying to convert
 * would require a trusted price oracle; separate rails with separate
 * caps is simpler and harder to bypass.
 *
 * Atomic reserve/release semantics:
 *   reserve(sats)        — deducts sats immediately (before payment)
 *   release(sats)        — refunds sats on payment failure
 *   reserveUsdcCents()   — deducts USDC cents immediately
 *   releaseUsdcCents()   — refunds USDC cents on payment failure
 *
 * All amounts are integers. Fractional cents / sats rejected.
 */

export class BudgetTracker {
  private sessionSpentSats = 0;
  private sessionSpentUsdcCents = 0;
  private readonly maxPerRequestSats: number;
  private readonly sessionBudgetSats: number;
  private readonly sessionBudgetUsdcCents: number;

  constructor(
    maxPerRequestSats: number,
    sessionBudgetSats: number,
    sessionBudgetUsdcCents: number = 5_000, // default: $50 session USDC cap
  ) {
    if (!Number.isFinite(maxPerRequestSats) || maxPerRequestSats <= 0) {
      throw new BudgetError(`Invalid maxPerRequestSats: ${maxPerRequestSats}`);
    }
    if (!Number.isFinite(sessionBudgetSats) || sessionBudgetSats <= 0) {
      throw new BudgetError(`Invalid sessionBudgetSats: ${sessionBudgetSats}`);
    }
    if (!Number.isFinite(sessionBudgetUsdcCents) || sessionBudgetUsdcCents <= 0) {
      throw new BudgetError(`Invalid sessionBudgetUsdcCents: ${sessionBudgetUsdcCents}`);
    }
    if (!Number.isInteger(maxPerRequestSats)) {
      throw new BudgetError(`maxPerRequestSats must be integer: ${maxPerRequestSats}`);
    }
    if (!Number.isInteger(sessionBudgetSats)) {
      throw new BudgetError(`sessionBudgetSats must be integer: ${sessionBudgetSats}`);
    }
    if (!Number.isInteger(sessionBudgetUsdcCents)) {
      throw new BudgetError(`sessionBudgetUsdcCents must be integer: ${sessionBudgetUsdcCents}`);
    }
    this.maxPerRequestSats = maxPerRequestSats;
    this.sessionBudgetSats = sessionBudgetSats;
    this.sessionBudgetUsdcCents = sessionBudgetUsdcCents;
  }

  /**
   * Atomically check AND reserve sats budget for a request.
   * Deducts immediately to prevent race conditions with concurrent requests.
   * Call release() if the payment subsequently fails.
   */
  reserve(requestCostSats: number): void {
    if (!Number.isFinite(requestCostSats) || requestCostSats <= 0 || !Number.isInteger(requestCostSats)) {
      throw new BudgetError(`Invalid request cost: ${requestCostSats}`);
    }
    if (requestCostSats > this.maxPerRequestSats) {
      throw new BudgetError(
        `Request costs ${requestCostSats} sats, exceeds per-request limit of ${this.maxPerRequestSats} sats`
      );
    }
    if (this.sessionSpentSats + requestCostSats > this.sessionBudgetSats) {
      throw new BudgetError(
        `Session budget exhausted: spent ${this.sessionSpentSats}/${this.sessionBudgetSats} sats, request needs ${requestCostSats}`
      );
    }
    this.sessionSpentSats += requestCostSats;
  }

  /** Release previously reserved sats budget on payment failure. */
  release(sats: number): void {
    if (!Number.isFinite(sats) || sats < 0) {
      throw new BudgetError(`Invalid release amount: ${sats}`);
    }
    this.sessionSpentSats = Math.max(0, this.sessionSpentSats - sats);
  }

  /**
   * Atomically reserve USDC cents budget for an x402 request.
   *
   * @param cents — request cost in USDC cents (integer; 100 cents = $1)
   * @throws BudgetError if session USDC limit would be exceeded
   */
  reserveUsdcCents(cents: number): void {
    if (!Number.isFinite(cents) || cents <= 0 || !Number.isInteger(cents)) {
      throw new BudgetError(`Invalid USDC cost: ${cents} cents`);
    }
    if (this.sessionSpentUsdcCents + cents > this.sessionBudgetUsdcCents) {
      throw new BudgetError(
        `Session USDC budget exhausted: spent ${this.sessionSpentUsdcCents}/${this.sessionBudgetUsdcCents} cents, request needs ${cents}`
      );
    }
    this.sessionSpentUsdcCents += cents;
  }

  /** Release previously reserved USDC cents on payment failure. */
  releaseUsdcCents(cents: number): void {
    if (!Number.isFinite(cents) || cents < 0) {
      throw new BudgetError(`Invalid USDC release amount: ${cents}`);
    }
    this.sessionSpentUsdcCents = Math.max(0, this.sessionSpentUsdcCents - cents);
  }

  /** Remaining sats in session budget. */
  getRemaining(): number {
    return Math.max(0, this.sessionBudgetSats - this.sessionSpentSats);
  }

  /** Total sats spent this session. */
  getSpent(): number {
    return this.sessionSpentSats;
  }

  /** Remaining USDC cents in session budget. */
  getRemainingUsdcCents(): number {
    return Math.max(0, this.sessionBudgetUsdcCents - this.sessionSpentUsdcCents);
  }

  /** Total USDC cents spent this session. */
  getSpentUsdcCents(): number {
    return this.sessionSpentUsdcCents;
  }
}

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetError';
  }
}
