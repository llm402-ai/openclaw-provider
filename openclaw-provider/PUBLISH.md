# Publishing `@llm402/openclaw-provider` to npm

Single-package publish flow. Since v0.3.0, `@llm402/core` is merged into
this package — there is no separate core publish step.

---

## One-time setup (user action required)

### 1. npm scope ownership

You must own the `@llm402` npm scope. Verify:

```bash
npm owner ls @llm402/openclaw-provider
# If "no such package" — scope is unclaimed. Create an org on npmjs.com
# named "llm402" before publishing.
```

### 2. Trusted publisher configuration (OIDC)

https://docs.npmjs.com/trusted-publishers

Add a Trusted Publisher on npmjs.com for `@llm402/openclaw-provider`:
- **Publisher**: GitHub Actions
- **Repository owner**: `llm402-ai`
- **Repository**: `openclaw-provider`
- **Workflow filename**: `openclaw-provider-release.yml`
- **Environment**: leave blank (or `production` if you prefer GitHub
  environment-level approval gates)

**Zero long-lived tokens.** Do NOT add an `NPM_TOKEN` secret to the
repository — `grep -r NPM_TOKEN .github/workflows/` should return empty.

### 3. Branch protection on `main`

GitHub repo -> Settings -> Branches -> Branch protection rule for `main`:

- Require a pull request before merging
- Require approvals (minimum 1)
- Dismiss stale pull request approvals when new commits are pushed
- Require status checks to pass:
  - `openclaw-provider CI / test (ubuntu-latest, 22)`
  - `openclaw-provider CI / test (macos-latest, 22)`
  - `openclaw-provider CI / test (windows-latest, 22)`
- Require branches to be up to date before merging
- Require signed commits (recommended)
- Do NOT allow force pushes or deletions

---

## Publish flow

### 1. Version bump triplet

All three must match:
- `openclaw-provider/package.json` -> `version`
- `openclaw-provider/openclaw.plugin.json` -> `version`
- `openclaw-provider/src/version.ts` -> `PLUGIN_VERSION`

Verify: `cd openclaw-provider && npm run verify:versions`

### 2. PR + CI green

```bash
gh pr create --base main --head feat/llm402-merge-and-cli \
  --title "feat: @llm402/openclaw-provider v0.3.0" \
  --body-file openclaw-provider/CHANGELOG.md
```

CI must go green (3-OS x 2-Node matrix + bin-exec check) before merge.

### 3. Tag on main

After PR merges:

```bash
git checkout main
git pull
git tag openclaw-v0.3.0
git push origin openclaw-v0.3.0
```

The `openclaw-provider-release.yml` workflow fires, runs the
main-ancestor check, builds, verifies tag matches package.json,
and publishes `@llm402/openclaw-provider@0.3.0` to the `next` tag
on npm with provenance attestation.

Verify:

```bash
npm view @llm402/openclaw-provider versions
npm view @llm402/openclaw-provider dist-tags
# Expect: next: 0.3.0
```

### 4. 48-hour soak on `next` tag

Do NOT promote to `latest` yet. During the 48h window:

- Monitor npm downloads
- Watch for GitHub issues on the repo
- Server-side: check llm402.ai logs for
  `User-Agent: llm402-openclaw-provider/0.3.0`
- If ANY critical bug surfaces:
  `npm deprecate '@llm402/openclaw-provider@0.3.0' 'see 0.3.1'`
  and publish a patch

Power users who want to test early:

```bash
npm install @llm402/openclaw-provider@next
```

### 5. Promote `next` -> `latest`

In GitHub Actions, trigger the release workflow manually
(`workflow_dispatch`):

- Actions -> `openclaw-provider Release` -> `Run workflow`
- Package: `@llm402/openclaw-provider`
- Version: `0.3.0`

This runs `npm dist-tag add @llm402/openclaw-provider@0.3.0 latest`.

### 6. Deprecate `@llm402/core`

After `latest` promotion:

```bash
npm deprecate '@llm402/core@0.2.0' \
  'Merged into @llm402/openclaw-provider@0.3.0. Install that instead.'
```

---

## If something goes wrong

**Bad publish on `next` tag (within 48h soak):**
- `npm deprecate '@llm402/openclaw-provider@0.3.0' 'bug -- see 0.3.1'`
- Fix, bump to 0.3.1, re-tag, re-publish.
- NEVER `npm unpublish` — 72h window + breaks dependents.

**Critical bug after `latest` promotion:**
- Same `npm deprecate` flow.
- Add the broken version to `src/version.ts` `KNOWN_BROKEN_VERSIONS` in
  the patch release so the new build refuses to activate as the old one.

**OpenClaw SDK breaking change:**
- peerDep is pinned `>=2026.4.12 <2027.0.0`. A v2027 breaking change
  will prevent install — users see a clear peerDep conflict, not a
  runtime crash.

---

## Verification commands

```bash
# Prove the shipped package matches the git commit
npm audit signatures

# Verify the tarball hash matches CI's hash
npm pack @llm402/openclaw-provider@0.3.0
sha256sum llm402-openclaw-provider-0.3.0.tgz

# Check dist-tags
npm view @llm402/openclaw-provider dist-tags
```
