# Typosquat defense — placeholder packages

These five packages exist to deny common typo variants of the real
package, so users who mistype the install command end up at a README
that redirects them instead of installing a malicious lookalike.

**Real package**: [`@llm402/openclaw-provider`](https://www.npmjs.com/package/@llm402/openclaw-provider)

**Placeholders** (this directory):

| Name                             | Reason                          |
|----------------------------------|---------------------------------|
| `llm402-openclaw-provider`       | Unscoped variant                |
| `@llm402-ai/openclaw-provider`   | Dash-separated scope            |
| `@llm402ai/openclaw-provider`    | No-separator scope              |
| `openclaw-llm402-provider`       | Reordered name                  |
| `openclaw-provider-llm402`       | Appended name                   |

Each placeholder:
- Has no runtime code — only a README pointing users at the real package
- Has a `postinstall` script that prints a redirect notice to stderr
- Is version-locked at `0.0.1-placeholder`
- Never increments version (stay dormant; no auto-update surface)

## Publishing

One-time, after `@llm402` scope is verified and OIDC publisher is
configured for this repo:

```bash
bash scripts/publish-typosquats.sh
```

The script uses `npm publish --access public` for each unscoped name,
and `npm publish --access public` under the appropriate scope for the
scoped variants. Each publish is interactive (prompts for confirmation)
to avoid accidental fire-and-forget.

## Not maintained

Once published, these packages do NOT need updates. No CI matrix.
No CHANGELOG. They are zero-byte name reservations. If a legitimate
future product needs one of these names, we can transfer ownership
case-by-case.
