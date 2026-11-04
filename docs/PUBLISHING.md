# Publishing Pi Agent Manager

Releases are published by `.github/workflows/release.yml`. It runs on every push to `main`, and it releases when `package.json`'s `version` has no `vX.Y.Z` tag yet. Merging a release pull request that bumps the version is therefore the release. Pushes that don't change the version skip it. The workflow:

1. checks that the version is new (or that its tag already points at this commit, when re-running),
2. runs typecheck, lint, unit tests and the real-Pi end-to-end tests,
3. builds and verifies the VSIX,
4. creates the `vX.Y.Z` tag if needed and publishes the VSIX to the **VS Code Marketplace** (with Trusted Publishing) and **Open VSX** (when `OVSX_PAT` is set),
5. creates a GitHub Release with the VSIX and the matching `CHANGELOG.md` section.

Open VSX is skipped with a warning while `OVSX_PAT` is missing. The Marketplace step always runs, so set up its Trusted Publishing policy before the first release.

Extension ID: **`peilundai.pi-agent-manager`**. The ID can never change after the first publish.

## Status and what's left

| Store | State |
| --- | --- |
| VS Code Marketplace | Live as `peilundai.pi-agent-manager` since 0.2.2, published with Trusted Publishing. |
| Open VSX | Workflow ready. Waiting on the owner-only steps below; 0.2.2 was skipped with a warning. |

Only the repository owner can do these, because they need your Open VSX and GitHub accounts:

- [ ] Sign in at <https://open-vsx.org> with GitHub, link an Eclipse account and sign the publisher agreement ([step 1](#open-vsx)).
- [ ] Create an Open VSX access token ([step 2](#open-vsx)).
- [ ] Create the `peilundai` namespace with that token ([step 3](#open-vsx)).
- [ ] Add the token as the repository secret `OVSX_PAT` at <https://github.com/peilundai/pi-agent-manager/settings/secrets/actions> ([step 4](#open-vsx)).
- [ ] Publish the current version to Open VSX ([step 5](#open-vsx)). Later releases go there automatically.

## One-time setup

### VS Code Marketplace

1. Sign in at <https://marketplace.visualstudio.com/manage> with a Microsoft account and create the publisher **`peilundai`**. The ID must match `publisher` in `package.json`.
2. On the publisher's **Trusted Publishing** tab, create a policy so this repository's release workflow can publish without a token:
   - Policy name: `Release workflow`
   - Provider: **GitHub Actions**
   - Repository owner: `peilundai`
   - Repository: `pi-agent-manager`
   - Workflow: `release.yml`
   - Environment: leave empty

The workflow has `id-token: write` permission and runs `vsce publish --oidc`. GitHub issues a short-lived token for each run, so there's no secret to store or renew.

**Fallback: personal access token.** If Trusted Publishing fails, create an Azure DevOps token with the **Marketplace → Manage** scope, check it with `npx vsce verify-pat peilundai -p <token>`, and add it as the repository secret `VSCE_PAT`. While `VSCE_PAT` is set, the workflow publishes with it instead of Trusted Publishing; delete the secret to switch back.

### Open VSX

Open VSX serves Cursor, VSCodium, Windsurf, Gitpod and other VS Code–compatible editors.

1. Sign in at <https://open-vsx.org> with GitHub. In your profile settings, log in with an Eclipse Foundation account (create one at <https://accounts.eclipse.org> if needed; its GitHub username field must be `peilundai`) and sign the **Publisher Agreement**. Publishing fails until the agreement is signed.
2. Create an access token at <https://open-vsx.org/user-settings/tokens>, for example named `pi-agent-manager release`. Copy it now; it's shown once.
3. Create the namespace once. It must match `publisher` in `package.json`:

   ```sh
   npx ovsx create-namespace peilundai -p <token>
   ```

   Optionally, [claim the namespace](https://github.com/EclipseFdn/open-vsx.org/issues/new/choose) to get the "verified publisher" badge.
4. Add a repository secret named `OVSX_PAT` containing the token: **Settings → Secrets and variables → Actions → New repository secret**.
5. Publish the version that is already released, since its release run skipped Open VSX. Either:
   - open the [latest Release run](https://github.com/peilundai/pi-agent-manager/actions/workflows/release.yml) for that version and click **Re-run all jobs** (re-runs read the new secret; the Marketplace step skips the duplicate), or
   - download the `.vsix` from the [GitHub Release](https://github.com/peilundai/pi-agent-manager/releases/latest) and run `npx ovsx publish pi-agent-manager-<version>.vsix -p <token>`.

   Check the listing at <https://open-vsx.org/extension/peilundai/pi-agent-manager>. GitHub only allows re-runs for 30 days, so use the local command after that.

## Before every release

1. **Smoke-test the VSIX in real VS Code.** Download the `vsix` artifact from the latest green CI run, or run `npm run build && node scripts/package-vsix.mjs` locally. Then:
   - Install it: `code --install-extension pi-agent-manager-<version>.vsix`.
   - Open a project, run **Pi Agent Manager: Open**, and send a prompt with a real model.
   - Check an edit diff, an `@` mention, the `/` menu, **⌥L / Alt+L**, interrupting with Esc, Past Chats, and light and dark themes.
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
- **Marketplace sign-in fails:** check that the Trusted Publishing policy matches the owner, repository and workflow file name exactly, or use the `VSCE_PAT` fallback. Re-run the failed workflow afterwards.
- **Expired Open VSX token:** renew the token and update the repository secret. Re-run the failed workflow from the Actions tab; the tag doesn't need to change. Re-runs are safe after a partial publish: both publish steps use `--skip-duplicate`, so a store that already has the version is skipped.
