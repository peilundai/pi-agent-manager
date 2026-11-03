# Publishing Pi Agent Manager

Releases are published by `.github/workflows/release.yml`. It runs on every push to `main`, and it releases when `package.json`'s `version` has no `vX.Y.Z` tag yet. Merging a release pull request that bumps the version is therefore the release. Pushes that don't change the version skip it. The workflow:

1. checks that the version is new (or that its tag already points at this commit, when re-running),
2. runs typecheck, lint, unit tests and the real-Pi end-to-end tests,
3. builds and verifies the VSIX,
4. creates the `vX.Y.Z` tag if needed and publishes the VSIX to the **VS Code Marketplace** (when `VSCE_PAT` is set) and **Open VSX** (when `OVSX_PAT` is set),
5. creates a GitHub Release with the VSIX and the matching `CHANGELOG.md` section.

A store whose token is missing is skipped with a warning, so you can turn the stores on one at a time.

Extension ID: **`peilundai.pi-agent-manager`**. The ID can never change after the first publish.

## One-time setup

### VS Code Marketplace

1. Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account and create the publisher **`peilundai`**. The ID must match `publisher` in `package.json`.
2. In Azure DevOps (<https://dev.azure.com>, any organization), open **User settings → Personal access tokens** and create a token:
   - Organization: **All accessible organizations**
   - Scopes: **Custom defined → Marketplace → Manage**
   - Expiry: up to one year. Set a reminder to renew it.
3. Optional check from a terminal:

   ```sh
   npx vsce verify-pat peilundai -p <token>
   ```

4. In GitHub, open **Settings → Secrets and variables → Actions** and add a repository secret named `VSCE_PAT` containing the token.

### Open VSX

Open VSX serves Cursor, VSCodium, Windsurf, Gitpod and other VS Code–compatible editors.

1. Sign in at <https://open-vsx.org> with GitHub and accept the Eclipse Foundation publisher agreement in your profile.
2. Create an access token under **Settings → Access Tokens**.
3. Create the namespace once:

   ```sh
   npx ovsx create-namespace peilundai -p <token>
   ```

   Optionally, request namespace verification for the "verified publisher" badge.
4. Add a repository secret named `OVSX_PAT` containing the token.

## Before every release

1. **Smoke-test the VSIX in real VS Code.** Download the `vsix` artifact from the latest green CI run, or run `npm run build && node scripts/package-vsix.mjs` locally. Then:
   - Install it: `code --install-extension pi-agent-manager-<version>.vsix`.
   - Open a project, run **Pi Agent Manager: Open**, and send a prompt with a real model.
   - Check an edit diff, an `@` mention, the `/` menu, **⌘L / Ctrl+L**, interrupting with Esc, Past Chats, and light and dark themes.
   - If possible, test on Windows too: pi installed through npm resolves to a `.cmd` file there.
2. Update `CHANGELOG.md`: replace "Unreleased" in the version heading with the release date, and describe the changes.
3. Bump `version` in `package.json` for later releases. Use `npm version patch|minor --no-git-tag-version` so `package-lock.json` matches.
4. Regenerate third-party notices if dependencies changed: `npm run notices`.
5. Open a pull request whose title follows Conventional Commits, for example `chore(release): 0.2.0`. See `AGENTS.md`.

## Release

Merge the release pull request. The **Release** workflow in the Actions tab tags the merge commit, publishes it and creates the GitHub Release. Marketplace listings usually appear within a few minutes; Open VSX is immediate.

Other ways to start a release, all running the same checks:

- **Run workflow** on the **Release** workflow in the Actions tab, with `main` selected. It does nothing if the version's tag already exists on another commit.
- Push a tag by hand: `git tag v0.2.0 && git push origin v0.2.0`. The tag must match `package.json`.
- Publish a release in the GitHub UI with a new `vX.Y.Z` tag on `main`. The workflow fills in its notes and attaches the VSIX.

A tag that the workflow creates itself doesn't start a second run, because GitHub doesn't trigger workflows from pushes made with `GITHUB_TOKEN`. If a tag ruleset protects `v*` tags, allow GitHub Actions to create them.

## Preview and pre-releases

- `"preview": true` in `package.json` shows a **Preview** badge on the listing. Remove it once the extension is stable.
- For pre-release builds alongside stable ones, use an odd minor version (for example 0.3.x) and add `--pre-release` to both publish commands. That's not needed for the first release.

## If something goes wrong

- **Unpublish or remove a version:** `npx vsce unpublish peilundai.pi-agent-manager` removes the whole extension, so prefer publishing a fixed patch version. On Open VSX, ask the namespace owner or the Open VSX team to remove a version.
- **Expired token:** renew the token and update the repository secret. Re-run the failed workflow from the Actions tab; the tag doesn't need to change. Re-runs are safe after a partial publish: both publish steps use `--skip-duplicate`, so a store that already has the version is skipped.
