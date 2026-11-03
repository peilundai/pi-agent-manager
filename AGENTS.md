# Pi Agent Manager: contributor and agent guide

## Commit messages: Conventional Commits (required)

Every commit message, and every pull request title, follows [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<optional scope>)<!>: <imperative summary, lowercase, no trailing period>

<optional body: what changed and why, wrapped at ~72 columns>

<optional footers, e.g. BREAKING CHANGE: ..., Refs: #123>
```

- **Types:** `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`, `chore`, `style`, `revert`.
- **Scopes** are optional, for example `deps`, `deps-dev`, `webview`, `rpc`, `release`.
- Mark breaking changes with `!` after the type or scope, or with a `BREAKING CHANGE:` footer.
- Keep the summary at 72 characters or fewer, written as a command ("add", not "added").
- **PR titles must follow the same format.** Pull requests are squash-merged, so the PR title becomes the commit message on `main`. GitHub appends ` (#123)`.
- Examples:
  - `feat(webview): show a context-usage ring in the composer`
  - `fix: keep the latest draft when the composer remounts`
  - `build(deps-dev): upgrade vitest to 5.1`
  - `chore(release): 0.2.0`
- No AI attribution trailers or footers in commits or PR descriptions; `.claude/settings.json` disables them.

## Branches and pull requests

- Work on a branch and merge to `main` through a pull request; never push directly to `main`.
- Never rewrite history that is already on `main`.
- A pull request is ready when CI is green and review threads are resolved.

## Checks before pushing

```sh
npm run check          # tsc + ESLint (React Compiler rules on; fix code, don't disable rules)
npm test               # unit and component tests (Vitest)
npm run test:coverage  # with coverage thresholds
npm run test:e2e       # real Pi CLI against a mock LLM (no API key needed)
npm run test:ui        # Playwright webview tests
```

When dependencies change, run `npm run notices` to regenerate `THIRD_PARTY_NOTICES.md`.

## Project notes

- Extension ID `peilun-dai.pi-agent-manager`, display name **Pi Agent Manager**. Command, setting, view and context-key identifiers use the `piAgentManager.` prefix.
- This is an unofficial client for the Pi coding agent (MIT, © Mario Zechner). Don't bundle Pi code or use Pi's logo, and keep the attribution in `THIRD_PARTY_NOTICES.md` and `src/webview/theme.css`.
- Architecture: `docs/architecture.md`. Releasing: `docs/PUBLISHING.md`.
