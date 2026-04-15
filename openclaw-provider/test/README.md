# Test suite for @llm402/openclaw-provider

## Unit + integration tests (run on every commit)

```bash
cd openclaw-provider
npm test
```

Runs `test/run.ts`: 100+ tests covering config validation, budget
tracker (sats + USDC rails), model catalog, payment proxy flow,
x402 signing, Layer 1 hardening, Layer 2 secret redaction + env
resolvers. Under 30 seconds, no network, no real payments.

## Live E2E test (opt-in)

Hits the real llm402.ai API and sends one chat completion per
payment mode that has credentials configured. Requires **both**:

1. Environment flag: `OPENCLAW_E2E=1` (guard against accidental runs)
2. CLI flag: `--target <https-url>` (no default — guard against
   accidental prod hits)

```bash
OPENCLAW_E2E=1 \
  LLM402_E2E_BALANCE_TOKEN=bal_... \
  LLM402_E2E_NSEC=nsec1... \
  LLM402_E2E_EVM_KEY=0x... \
  tsx test/e2e-openclaw-install.ts --target https://llm402.ai
```

### Credential matrix

| Env var                     | Exercises mode           | Spend per run |
|-----------------------------|--------------------------|---------------|
| `LLM402_E2E_BALANCE_TOKEN`  | `balance` (Bearer)       | ~1–5 sats     |
| `LLM402_E2E_NSEC`           | `cashu` + `lightning`    | ~2–10 sats/mode |
| `LLM402_E2E_EVM_KEY`        | `x402` (USDC on Base)    | ~$0.001       |

Each credential is independent. Missing credentials = SKIP (not
FAIL). Test still exits 0 if you only set some of them.

### What the E2E test asserts

For each mode: activate the plugin (same entry point OpenClaw
calls), fetch the model catalog, verify it loaded, and shut down
cleanly. Does NOT drive the full OpenClaw CLI loader — that's
covered by the Layer 8 cross-OS CI matrix.

### Getting test credentials

- **Balance token**: visit https://llm402.ai/chat and fund a
  prepaid balance; the `bal_*` token is displayed.
- **Nostr nsec**: generate one locally (`npx nostr-tools genkey`) or
  export from any NIP-60 Cashu client (Minibits, Nutstash, etc.).
  The nsec must control a funded Cashu wallet — the plugin spends
  proofs from it, it does not create or fund them.
- **EVM key**: use `test-x402/test-wallet.json` from the llm402
  repo (gitignored, test-only wallet with small USDC on Base).
  DO NOT use a real funded wallet for this test.

## Live install test via OpenClaw (Layer 8)

The full "install this plugin into a fresh OpenClaw v2026.4.12
and run through its plugin loader" test lives in CI only.
See `.github/workflows/openclaw-provider-ci.yml`.
