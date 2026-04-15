# Security Policy

## Scope

`@llm402/openclaw-provider` handles real money: Bitcoin Lightning payments,
USDC on Base, Cashu ecash tokens, and prepaid balance tokens tied to
llm402.ai credit. This document covers:

1. Threat model — what we defend against and what we don't
2. Key storage — on-disk wallet handling per OS
3. Supply chain — how to verify you have an unmodified build
4. Reporting vulnerabilities — private disclosure process
5. Accepted limitations — known issues we've triaged but not yet fixed

---

## 1. Threat model

### In scope

- **Remote attackers against llm402.ai**: the x402 signing path validates
  the server's advertised `payTo`, `asset`, `network`, and hardcodes the
  EIP-712 USDC domain. A compromised llm402.ai cannot redirect your USDC.
- **Co-resident OpenClaw plugins (malicious or buggy)**: the proxy binds
  to 127.0.0.1 only and requires a 32-byte per-session auth token
  (constant-time compared). `globalThis.fetch` is snapshotted at import
  time so monkey-patching by other plugins has no effect on our payment
  path.
- **Log/error exfiltration**: all error messages pass through
  `redactSecrets()` which strips Bearer tokens, L402 macaroon/preimage,
  nsec, cashu tokens, and 0x-prefixed EVM keys.
- **Runaway cost bugs**: budgets are enforced BEFORE signing. Sats and
  USDC cents are tracked independently (no oracle, no conversion risk).
- **Upstream SDK breakage**: peerDep is bounded `>=2026.4.12 <2027.0.0`.
  `KNOWN_BROKEN_VERSIONS` check at activate() refuses to run if the
  current build is marked broken.

### Out of scope (intentionally)

- **Anyone with filesystem read access to your home directory.** The
  wallet file is protected by OS-level perms (0600 on Unix). If an
  attacker has those perms, they have the wallet — and in that case
  they can also read your SSH keys, browser cookies, and GPG keys.
  This is the standard threat model for CLI wallets (lnd, cashu-ts,
  `cast` in foundry, etc.).
- **CI runners, Codespaces, dev containers, shared workstations.**
  Do not install the plugin in any of those environments. The README
  and this document say so explicitly.
- **Physical access to the device.** Disk encryption is your job.
- **Other OpenClaw plugins with filesystem access.** We cannot defend
  against a malicious plugin that reads `~/.llm402/wallet.json`
  because it runs in the same user process. Keep plugins you install
  to a minimum and only from trusted authors.

---

## 2. Key storage

### File location

`~/.llm402/wallet.json` — contents include:
- Nostr `nsec` (used as Cashu wallet seed via NIP-60)
- Optional EVM private key (x402 mode)
- Cashu proofs (ecash balance)

### Permissions

- **macOS / Linux**: file is created with `mode: 0o600` (owner
  read/write only). Verify:
  ```bash
  ls -l ~/.llm402/wallet.json
  # -rw-------  1 you  staff  ...  wallet.json
  ```
- **Windows**: default NTFS ACL (Owner + SYSTEM). To harden:
  ```powershell
  icacls "$env:USERPROFILE\.llm402" /inheritance:r /grant:r "${env:USERNAME}:(F)"
  ```
  Consider enabling BitLocker for full-disk encryption.

### Rotation

1. Drain the old wallet (send remaining funds elsewhere).
2. Stop OpenClaw completely.
3. Delete `~/.llm402/wallet.json`.
4. Restart OpenClaw; plugin creates a fresh wallet on first activation.
5. Fund the new wallet.

### Backup

The wallet file is a JSON document; back it up like any other secret.
**Do not commit it to git.** `~/.llm402/` is outside the repo by default.

---

## 3. Supply-chain verification

We publish only via GitHub Actions OIDC — no long-lived npm tokens
exist anywhere in the repo or on any developer laptop.

Every publish carries an npm provenance attestation. To verify you
have an unmodified build linked to a specific commit:

```bash
npm install @llm402/openclaw-provider
npm audit signatures
```

You should see a successful verification. If `npm audit signatures`
reports a tampered or unsigned package, do NOT use it. File an
immediate report (see §4).

The current supported scope prefix is `@llm402/`. Typosquat placeholders
are registered for:
- `llm402-openclaw-provider` (unscoped)
- `@llm402-ai/openclaw-provider`
- `@llm402ai/openclaw-provider`

If you find a non-official package under any similar name, please
report it.

### Required maintainer setup (one-time)

1. Create `@llm402` npm scope (or confirm ownership)
2. Configure trusted publisher on npmjs.com for each package:
   - Repository: `llm402/llm402`
   - Workflow: `openclaw-provider-release.yml`
3. Enable branch protection on `main`:
   - Require `openclaw-provider CI / test` to pass before merge
   - Require pull request review before merge
   - Do not allow force-pushes or direct commits
4. Do not add `NPM_TOKEN` to repository secrets.

---

## 4. Reporting vulnerabilities

**Do not open a public GitHub issue for security bugs.**

Preferred: GitHub private vulnerability disclosure on
[github.com/llm402-ai/openclaw-provider/security/advisories/new](https://github.com/llm402-ai/openclaw-provider/security/advisories/new).

Alternative: email `security@llm402.ai` (if configured).

Include:
- Version of `@llm402/openclaw-provider`
- OpenClaw version
- Node version + OS
- Reproduction steps
- Impact description (what secret could leak? what money could move?)

We aim to triage within 48 hours and ship a patch within 7 days for
critical findings.

---

## 5. Accepted limitations (v0.3.0)

These are triaged and not yet fixed.

- **Wallet keys unencrypted at rest.** 0600 perms are our defense; OS
  keychain integration (macOS Keychain, Windows DPAPI, libsecret on
  Linux via `keytar`) is planned for a future release.
- **No direct NWC or LNURL wallet connect.** Lightning payments route
  through Cashu-melt-for-invoice. Direct NWC connect is planned for
  a future release.
- **Cashu mint URL allowlist is shape-based**, not content-based. URL
  must be HTTPS with no private IPs, but any HTTPS mint the user
  configures is honored. Plugin does not maintain a curated trusted
  mint list.
- **Cashu melt preimage loss edge case.** Some mints do not return
  `payment_preimage` on successful melt, in which case sats are paid
  but the L402 macaroon cannot be verified. Mint-dependent;
  Minibits and Voltz tested working.
- **Windows 0600 not honored.** Windows does not have Unix file
  perms. Default ACL + BitLocker is recommended. Explicit ACL
  hardening command in README.

---

## Contact

- Vulnerabilities: see §4 above
- Other security questions: `security@llm402.ai` or open a public
  discussion (non-sensitive only)
