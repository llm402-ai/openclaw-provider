# ClawHub submission — @llm402/openclaw-provider

This document is the template for the ClawHub submission PR + any
preflight discussion with OpenClaw/ClawHub maintainers.

## Preflight questions (open first, before submitting)

Post these in a GitHub discussion on `openclaw/clawhub` (or equivalent
channel) before submitting the plugin. Waiting for answers prevents
submitting blindly and joining the same 2+-month queue as ClawRouter
(`openclaw/clawhub#125`).

1. **Duplicate plugin id handling.** Our manifest declares
   `id: "llm402-provider"`. What happens if someone later publishes a
   plugin with the same `id`? Is there a verified-publisher concept
   or a "verified by llm402.ai org" badge?

2. **Local-proxy-swallow-402 pattern policy.** We run a local HTTP
   proxy on 127.0.0.1 to absorb 402 responses before OpenClaw sees
   them (same pattern ClawRouter uses — a workaround for
   `openclaw/openclaw#30484` treating 402 as a fatal billing error).
   Is this pattern accepted? Is there a preferred alternative we
   should use instead?

3. **Review SLA.** ClawRouter's submission has been pending 2+ months.
   Is there a targeted review timeline, or is ClawHub effectively
   npm-only until review is rewritten? Users can install directly
   from `@llm402/openclaw-provider` on npm meanwhile — we want to
   know whether ClawHub listing is a near-term or long-term step.

4. **Payment-handling disclosure.** We handle wallet keys and real
   money. Does ClawHub require any specific disclosure, threat-model
   template, or audit report? (We ship `SECURITY.md` with a full
   threat model; happy to extend it if a canonical format exists.)

5. **npm scope verification.** Is `@llm402` scope ownership verified
   via npm provenance attestation sufficient, or does ClawHub have a
   separate publisher-identity flow?

## Submission PR template

File a PR against `github.com/openclaw/clawhub` once the preflight
answers are in. Use this as the PR description:

```markdown
# Add @llm402/openclaw-provider

Official plugin for [llm402.ai](https://llm402.ai) — first
Lightning-native LLM provider in OpenClaw.

## Overview

- **npm**: [`@llm402/openclaw-provider`](https://www.npmjs.com/package/@llm402/openclaw-provider) — public, provenance-attested
- **Repo**: [github.com/llm402-ai/openclaw-provider](https://github.com/llm402-ai/openclaw-provider)
- **Type**: Provider plugin (not a channel or skill)
- **Supports**: OpenClaw v2026.4.12+ (peerDep bounded
  `>=2026.4.12 <2027.0.0`)

## What it offers

- 335+ AI models across Together.ai, OpenRouter, DeepInfra
- 4 payment rails: prepaid balance (simplest), Cashu ecash, x402
  (USDC on Base), L402 Lightning (via Cashu-melt)
- Local 127.0.0.1 proxy absorbs 402 responses (ClawRouter-pattern
  workaround for openclaw/openclaw#30484)
- Per-session sats + USDC cents budgets with atomic reserve/release
- No accounts, no API keys

## Security

- Every publish carries npm provenance attestation (OIDC trusted
  publisher, no long-lived token)
- Full threat model in
  [SECURITY.md](https://github.com/llm402-ai/openclaw-provider/blob/main/SECURITY.md)
- 30 internal pentester iterations + 6-agent consensus review
- 100+ unit tests, CI matrix: ubuntu/macos/windows × Node 22/24
- Private vulnerability disclosure via GitHub security advisories

## Distinguishing from ClawRouter

ClawRouter (`BlockRunAI/ClawRouter`) is x402-only, 41+ models.
We are Lightning-native first, 335+ models, 4 payment rails. We
use the same local-proxy pattern out of necessity — both plugins
work around openclaw/openclaw#30484. We think there's room for
both.

## Checklist

- [ ] npm package published with provenance
- [ ] CI matrix green on ubuntu/macos/windows × Node 22/24
- [ ] SECURITY.md with threat model + disclosure policy
- [ ] CHANGELOG.md with v0.2.0 delta
- [ ] README.md with per-OS install + payment mode docs
- [ ] Plugin id (`llm402-provider`) confirmed non-conflicting with
      preflight discussion answer
```

## Follow-up work not in v0.2.0

If ClawHub requires changes during review:

- Manifest schema updates → bump to v0.2.1, republish, update PR
- Additional audit requirements → ship `docs/audit-<date>.md` and
  extend `SECURITY.md`
- Verified-publisher badge application → separate issue in
  llm402 repo for tracking

Do not `npm unpublish` any version regardless of ClawHub status.
Always deprecate + patch.
