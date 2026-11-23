# Installation — KπX fork (V2, local `file://`)

> This is the canonical install guide for the `@kpihx-labs/opencode-agy-auth` fork.
> The upstream `README.md` describes the old npm/`google-agy`/`projectId` flow. For this fork, follow this file.

Fork identity: `@kpihx-labs/opencode-agy-auth` `1.6.0-kpihx.2`.
Canonical branch: `feat/agy-v2-single-account` (HEAD `75208d6` or later).
The plugin is **loaded from the kernel as a local `file://` plugin** — it is not installed from npm.

## Agent compatibility (important)

This plugin is **only usable with KπX's custom agents** (`Live`, `Colab`, `Lite`, `Explore`, …).
OpenCode's **built-in agents** (`build`, `plan`, `general`) are **not supported**. Requests sent through
the built-in `build` agent with an `agy/*` model are rejected by the Antigravity backend with
`RESOURCE_EXHAUSTED` (HTTP 429) even when the account quota is healthy. The root cause is on the
backend side (request classification keyed on the stock OpenCode system prompt); the plugin itself
stays account- and agent-agnostic. Use `--agent Live` (or any custom agent) — `default_agent` is
already `Live` in the kernel config.

## Install from scratch — 6 steps

### 1. Clone into the kernel

```bash
git clone git@github.com:kpihx-labs/opencode-agy-auth.git \
  ~/.agents/skills/k-opencode/scripts/plugins/opencode-agy-auth
cd ~/.agents/skills/k-opencode/scripts/plugins/opencode-agy-auth
```

GitLab mirror (same content): `git@gitlab.com:kpihx-labs/opencode/opencode-agy-auth.git`.
Never `origin`, never HTTPS.

### 2. Check out the canonical branch and install dependencies

```bash
git checkout feat/agy-v2-single-account
npm ci
```

### 3. Build the local artefact

```bash
npm run build     # tsc && tsc -p tsconfig.build.json && tsup
```

This produces `dist/index.js` (the entrypoint OpenCode loads) and its source map.
The build gate (`tsc` before `tsup`) is mandatory — do not skip it.

### 4. Register the plugin in the OpenCode config

Source of truth: `~/.agents/skills/k-opencode/assets/opencode.jsonc`
(symlinked at `~/.config/opencode/opencode.jsonc`). Add to the `plugins` array:

```jsonc
{
  "package": "file://{env:HOME}/.agents/skills/k-opencode/scripts/plugins/opencode-agy-auth",
  "options": { "ids": ["agy", "agy-x"] }
}
```

`ids` declares N independent accounts. Each ID maps to one OpenCode integration + provider and
one OAuth credential owned by OpenCode. Default when `ids` is absent: `["agy"]`.

### 5. Authenticate each account

```bash
opencode auth login agy
opencode auth login agy-x
```

Each login opens the Google OAuth flow; paste the full redirect URL (or just the code) when asked.
Tokens are stored by OpenCode — never in the plugin:

- `~/.local/share/opencode/opencode.db` → `credential` table, `integration_id = agy` / `agy-x` (live store).
- `~/.local/share/opencode/auth.json` → legacy `google-agy` entry (V1 fallback, single account).

The plugin refreshes expired tokens itself through the shared in-memory cache with in-flight dedup.

### 6. Verify

```bash
opencode models | rg '^agy'        # catalogs loaded from each account's live quota
```

In a TUI session, run `/agy-quota` and `/agy-quota-summary` (also `agy-x` variants) to confirm
quota retrieval. Use a custom agent (`--agent Live`) for any request.

## Adding a third account

1. Add the new ID to `options.ids` in `opencode.jsonc`: `["agy", "agy-x", "agy-z"]`.
2. Run `opencode auth login agy-z`.

The plugin auto-creates the provider, integration, OAuth method and quota-based model catalog for
the new ID. Verify with `opencode models | rg '^agy-z'`.

## Development loop

Edit `src/`, run `npm run build`; OpenCode watches `dist/index.js` and reloads automatically.
No publish/install cycle. Tests: `npm test` (vitest).

## Updating

```bash
git fetch github && git rebase github/feat/agy-v2-single-account
npm ci && npm run build
```
