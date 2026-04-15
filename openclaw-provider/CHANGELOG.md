# Changelog

All notable changes to `@llm402/openclaw-provider` are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [SemVer](https://semver.org/).

---

## [0.3.0] — 2026-04-15

Single-package release. `@llm402/core` is merged into this package; no
separate dependency required. Ships a CLI for wallet management.

### Added

- **CLI** (`llm402-openclaw`): 5 commands — `init`, `fund`, `balance`,
  `check-funding`, `sync`. Installed via `bin` field; use with
  `npx llm402-openclaw <command>`.
- **Subpath export `./lib`**: barrel re-export of the ex-`@llm402/core`
  modules (wallet, client, x402, types). Import via
  `@llm402/openclaw-provider/lib`.
- **`validateRelayUrl()`**: exported alongside `validateMintUrl()` for
  Nostr relay URL validation.

### Changed

- **`checkFunding()` return type**: `boolean` -> `'paid' | 'expired' | 'unpaid'`.
  Callers using `if (result === true)` must update to `if (result === 'paid')`.
- **`syncFromNostr()` signature**: now takes
  `opts?: { relays?: string[]; allowRemoteMints?: boolean }` and returns
  `{ events: number; proofsAdded: number; sats: number }`.
- **Dependencies**: `@cashu/cashu-ts`, `nostr-tools`, and `viem` are now
  direct dependencies (were transitive via `@llm402/core`).

### Deprecated

- **`@llm402/core@0.2.0`** on npm. Will be formally deprecated via
  `npm deprecate` after this release ships. All functionality is now in
  `@llm402/openclaw-provider`.

### Removed

- **`@llm402/core` as a separate package**. Merged into
  `openclaw-provider/src/lib/`.
- **CI "Build core" step**. Replaced with bin-exec check and simplified
  integration test.

### Known limitations

- `viem` lazy-load refactor deferred to 0.3.1. `wallet.ts` and `client.ts`
  have top-level `viem` imports, adding ~66 MB install size for all users
  regardless of payment mode.
- Wallet save/load hardening deferred to 0.3.1 (no symlink check,
  non-unique temp file).
- Multi-terminal `fund` race condition: pending directory uses local files
  with no lock.
- Cross-device pending-quote recovery: pending quotes are local-only and
  cannot be resolved from another machine.

---

## [0.2.0] — 2026-04-14

First public release. v0.1.0 existed internally but was never published
to npm. This release incorporates a full 6-specialist consensus review
(skeptic / advocate / pentester / lightning / sysadmin / devops) and a
second pre-publish consensus gate after the ship-plan was executed,
resolving the round-1 findings listed in the "Round 2 fixes" block
below. Plus 30 internal pentester iterations.

### Round 2 fixes (from pre-publish consensus gate)

- **USDC cents budget leak on signing failure** (skeptic HIGH).
  The Layer 2 reserveUsdcCents call lived inside signX402; the
  caller's `x402CentsReserved` was only set AFTER signX402 returned.
  If signing threw (e.g., bad payTo, viem import flake), the reserve
  happened but the release branch saw x402CentsReserved == 0 and
  silently leaked session budget. Fix: caller now owns the
  reservation lifecycle — reserves BEFORE signX402, releases in an
  inner try/catch on any throw, keeps reserve on success. New
  regression test verifies USDC budget fully restored when all
  payment methods fail.
- **Modern plugin entry point** (openclaw specialist MED). The
  legacy `activate()` export is preserved for compat, and a modern
  `default export` with `{ id, name, register(api) }` shape is
  added per https://docs.openclaw.ai/tools/plugin. Both paths wire
  to the same activate() logic.
- **configSchema in openclaw.plugin.json** (openclaw specialist MED).
  JSON Schema declaring all user-facing fields with constraints.
  Enables strict manifest validation by OpenClaw's loader.
- **Bolt11 invoice redaction** (skeptic MED). `redactSecrets` now
  catches `ln(bc|tb|bcrt)...` invoices alongside the existing
  patterns. Bolt11 is not a secret in the cryptographic sense but
  reveals payment_hash + mint route in logs.
- **Typosquat ESM compatibility** (skeptic MED). 5 typosquat
  placeholder packages now declare `"type": "module"` and ship
  both `index.js` (ESM) and `index.cjs` (CJS) entry points — both
  throw on load. Previously only the CJS require() path triggered.
- **Prepack hook on openclaw-provider** (devops HIGH). Matches the
  core package: `prepack` runs `clean && build && verify:versions`
  before every `npm pack` / `npm publish`. Prevents a developer
  shipping stale build/ content or version-drifted manifest.
- **Release workflow main-ancestor check** (devops HIGH). Both the
  core and plugin publish jobs now run
  `git merge-base --is-ancestor $GITHUB_SHA origin/main` after
  checkout with `fetch-depth: 0`. Refuses to publish from a tag
  pointing at a non-main commit, closing the "stale feature-branch
  tag publishes unreviewed code" vector.

### Added

- **`src/redact.ts`** — pure-function `redactSecrets()` helper covering
  L402 macaroon:preimage, `Authorization: Bearer`, `bal_*` balance
  tokens, `cashu[AB]*` tokens, `X-Cashu` headers, `nsec1*` Nostr keys,
  `0x*` EVM private keys. Called on every log + error response.
- **`src/version.ts`** — single source of truth for `PLUGIN_VERSION`
  and `USER_AGENT` string. Exports `KNOWN_BROKEN_VERSIONS` and
  `assertVersionNotBroken()` for defense-in-depth alongside
  `npm deprecate`.
- **Cross-rail USDC budget** — `BudgetTracker.reserveUsdcCents()` /
  `releaseUsdcCents()` / `getSpentUsdcCents()` / `getRemainingUsdcCents()`.
  New config field `sessionBudgetUsdcCents` (default 5000 = $50).
  The x402 signing path reserves cents BEFORE producing the
  authorization; session cap cannot be bypassed.
- **User-Agent stamp** — every outbound HTTP request (probe, paid,
  catalog, passthrough) carries `llm402-openclaw-provider/<version>`.
  Enables server-side traffic segmentation + emergency kill-switch.
- **Production baseUrl hardcoding** — `BASEURL_PROD = 'https://llm402.ai'`.
  Dev override via env `LLM402_BASE_URL_OVERRIDE`, still validated
  against HTTPS + no-private-IP rules.
- **Base RPC URL allowlist** — env `LLM402_BASE_RPC_URL_OVERRIDE` is
  restricted to `{mainnet.base.org, base.llamarpc.com,
  base-rpc.publicnode.com, developer-access-mainnet.base.org}`. Any
  other value throws at startup. Blocks co-resident-plugin RPC hijack.
- **CI workflows** (`.github/workflows/`): 6-cell matrix
  (ubuntu/macos/windows × Node 22/24) runs build + test + tarball
  hygiene check on every push + PR. Release workflow publishes via
  OIDC trusted publisher with provenance attestation on tag push.
- **E2E runner** (`test/e2e-openclaw-install.ts`): live test against a
  `--target` URL, per-mode gated by env credentials. Follows
  `test-integration-chaos.js` pattern (mandatory flag, no prod default).
- **Docs**: `SECURITY.md` with full threat model, rotation, disclosure.
  `CHANGELOG.md` (this file). `test/README.md` with credential matrix
  and spend estimates. README rewritten with per-OS install and
  security-first ordering.
- **`.gitattributes`** (repo-root): forces LF line endings on text
  files to avoid Windows CRLF drift.

### Fixed

- **Auth contract docstring mismatch** (`src/index.ts`). The earlier
  docstring suggested OpenClaw should set
  `Authorization: Bearer <proxyAuthToken>`, but the proxy code
  validates `x-proxy-auth: <token>` only. If OpenClaw had followed
  the docstring, every request would have 403'd. Docstring now
  matches code; regression test added.
- **`n` parameter stripping** (`src/proxy.ts`). The plugin now forces
  `body.n = 1` before any probe or paid forward. Prior behavior
  forwarded client-supplied `n` unchanged, enabling "pay once, get N
  responses" economic abuse. Per the `server.js` CLAUDE.md rule.
- **Pre-existing type error** (`src/proxy.ts`). `Server` was imported
  from `'net'`, which lacks `closeAllConnections`. Imported from
  `'http'` instead.
- **Wildcard `@llm402/core` dependency**. Was `"*"`; now pinned to
  exact `"0.2.0"`. Reproducible supply-chain builds.
- **peerDep upper bound**. Was `">=2026.3.24"` (open-ended); now
  `">=2026.4.12 <2027.0.0"`. Future OpenClaw v2027.x breaking
  changes will refuse to install rather than silently fail at
  runtime.
- **Source-map leak in tarball**. Stale `.js.map` files from a
  previous build with `sourceMap: true` shipped in the published
  tarball. `tsconfig.sourceMap` is already `false`; the `prepack`
  script now does `clean && build` to guarantee no stale maps.

### Changed

- **`peerDependencies.openclaw`**: `">=2026.3.24"` → `">=2026.4.12 <2027.0.0"`
- **`dependencies["@llm402/core"]`**: `"*"` → `"0.2.0"` (exact pin)
- **`engines.node`**: added `">=22"`
- **`publishConfig`**: added `{access: public, provenance: true}`
- **`BudgetTracker` constructor signature**: now takes a third
  `sessionBudgetUsdcCents` parameter (default 5000). Backwards
  compatible for existing callers since the param has a default.
- **`sendPaidRequest` signature**: added `usdcCentsReserved` parameter
  (default 0). Internal refactor; not exported.

### Security

See also `SECURITY.md` for the full threat model.

- All `console.error` sites in payment paths now route through
  `redactSecrets()`.
- The x402 signing path validates `payTo`, `asset`, `network`, and
  enforces a hardcoded $5/request USDC cap before signing, then
  reserves session cents, then signs. All three barriers are
  independent.
- `KNOWN_BROKEN_VERSIONS = []` shipped empty; the check fires at
  activate and refuses to run if the current version is listed.
- OIDC trusted publisher for npm — no long-lived `NPM_TOKEN` in the
  repo. Every publish carries provenance; verify with
  `npm audit signatures`.

### Known limitations (not fixed in 0.2.0)

- Wallet keys stored unencrypted at `~/.llm402/wallet.json`.
- No direct NWC/LNURL Lightning wallet support (Cashu-melt path only).
- Cashu mint URL allowlist is shape-based, not content-based.
- Cashu melt may lose preimage on some mints (mint-dependent).
- Windows does not honor Unix 0600; ACL + BitLocker recommended.

See `SECURITY.md` §5 for accepted limitations.

---

## [0.1.0] — 2026-04-08

Internal release. Never published to npm. Merged to `main` via PR #241.
See git log for detail.
