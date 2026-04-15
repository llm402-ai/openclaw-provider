# @llm402/openclaw-provider

Official OpenClaw provider plugin for [llm402.ai](https://llm402.ai).
Pay-per-request LLM inference via Bitcoin Lightning, USDC on Base, Cashu
ecash, or prepaid balance tokens. 335+ models, 4 payment rails, no accounts.

> **⚠️ Before installing**, read [SECURITY.md](openclaw-provider/SECURITY.md).
> This plugin handles wallet keys and real money. Never install on shared
> systems, CI runners, or development sandboxes.

## Quick install

```bash
npm install @llm402/openclaw-provider
```

Full per-OS install + payment-mode config: [openclaw-provider/README.md](openclaw-provider/README.md).

## Repository layout

Single npm package plus tooling (since 0.3.0 `@llm402/core` has been merged
into `@llm402/openclaw-provider/src/lib/`):

```
/
├── openclaw-provider/       ← @llm402/openclaw-provider (the plugin)
│   └── src/lib/             ← ex-@llm402/core (wallet, client, x402, types)
├── scripts/
│   ├── typosquats/          ← Defensive npm name reservations
│   ├── publish-typosquats.sh
│   └── clawhub-submission.md
└── .github/workflows/       ← CI (3-OS × 2-Node matrix) + OIDC release
```

Published under the [`@llm402`](https://www.npmjs.com/~llm402) npm scope.

## Documentation

- **[openclaw-provider/README.md](openclaw-provider/README.md)** — install, payment modes, budget controls, security
- **[openclaw-provider/SECURITY.md](openclaw-provider/SECURITY.md)** — full threat model, key storage per OS, vulnerability disclosure
- **[openclaw-provider/CHANGELOG.md](openclaw-provider/CHANGELOG.md)** — v0.1.0 → v0.2.0 delta (Keep-a-Changelog format)
- **[openclaw-provider/PUBLISH.md](openclaw-provider/PUBLISH.md)** — internal runbook for maintainers

## Development

```bash
git clone https://github.com/llm402-ai/openclaw-provider
cd openclaw-provider
npm install

# Build both workspaces
npm run build --workspaces

# Run tests (openclaw-provider)
npm test --workspace=@llm402/openclaw-provider
```

Requires Node.js 22+.

## Verifying a published tarball

Every publish carries an npm provenance attestation linking the tarball
to this repo + a specific commit + a CI workflow run. Verify:

```bash
npm install @llm402/openclaw-provider
npm audit signatures
```

See [SECURITY.md §3](openclaw-provider/SECURITY.md) for the full supply-chain posture.

## Reporting vulnerabilities

**Do not open a public GitHub issue for security bugs.**
See [SECURITY.md §4](openclaw-provider/SECURITY.md) for private disclosure.

## License

[MIT](LICENSE) — Copyright (c) 2026 llm402.ai
