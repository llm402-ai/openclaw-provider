/**
 * Secret redaction for error logging and error response bodies.
 *
 * Every string that can reach stdout/stderr, HTTP error bodies, or
 * telemetry MUST pass through this first. Regex-based; patterns cover
 * all known llm402 secret shapes.
 *
 * Pure function, no I/O, no side effects. Safe on any input (strings,
 * Errors, objects — anything is coerced to string before matching).
 *
 * Threat model:
 *   - A co-resident OpenClaw plugin logs our stack traces
 *   - A remote error reporter (Sentry, etc.) ingests our error messages
 *   - A user pastes a log snippet into a support forum
 *   - A compromised upstream returns an error body containing our token
 *
 * Patterns are ordered most-specific-first so that composite secrets
 * (e.g. "L402 macaroon:preimage") get a single clean redaction rather
 * than a partial two-pass replace.
 */

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // L402 auth header value: "L402 <macaroon>:<64-hex preimage>"
  [/L402\s+[A-Za-z0-9+/=\-_]+:[a-fA-F0-9]{64}/g, 'L402 [redacted]:[redacted]'],
  // HTTP Authorization: Bearer <token>  — always redact the token part
  [/(Authorization\s*:\s*Bearer\s+)\S+/gi, '$1[redacted]'],
  [/(Bearer\s+)bal_\S+/gi, '$1bal_[redacted]'],
  // Balance token in isolation
  [/bal_[A-Za-z0-9_-]{20,}/g, 'bal_[redacted]'],
  // Cashu token (cashuA or cashuB prefix + base64url body)
  [/cashu[AB][A-Za-z0-9_=/\-]{20,}/g, 'cashu[redacted]'],
  // X-Cashu header value
  [/(X-Cashu\s*:\s*)\S+/gi, '$1[redacted]'],
  // Nostr nsec (bech32 prefix + 58 body chars)
  [/nsec1[a-z0-9]{58}/gi, 'nsec1[redacted]'],
  // EVM private key (0x + exactly 64 hex) — word boundary prevents
  // partial matches on longer hex strings
  [/0x[a-fA-F0-9]{64}\b/g, '0x[redacted]'],
  // Bolt11 Lightning invoice. Not secret per se (it's meant to be shared
  // to pay), but it carries the payment_hash, amount, and routing hints
  // which deanonymize the mint/route in logs. Prefix lnbc/lntb/lnbcrt,
  // followed by bech32 body.
  [/\bln(bc|tb|bcrt)[0-9]*[munp]?[a-z0-9]{50,}\b/gi, 'ln[redacted]'],
];

/**
 * Redact all known secret patterns from the input.
 * Accepts any value; coerces via String(), Error.stack, or JSON.stringify.
 * Never throws — on JSON.stringify failure, falls back to String(input).
 */
export function redactSecrets(input: unknown): string {
  let s: string;
  if (input === null || input === undefined) {
    s = String(input);
  } else if (typeof input === 'string') {
    s = input;
  } else if (input instanceof Error) {
    s = input.stack ?? input.message ?? String(input);
  } else {
    try {
      s = JSON.stringify(input);
    } catch {
      s = String(input);
    }
  }

  for (const [pattern, replacement] of PATTERNS) {
    s = s.replace(pattern, replacement);
  }
  return s;
}
