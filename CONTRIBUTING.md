# Contributing to pi-bulletin

Thanks for helping make pi-bulletin better!

## Your first contribution

Looking for a place to start? Good first issues are labeled
[`good first issue`](https://github.com/forrestbthomas/pi-bulletin/labels/good%20first%20issue)
on GitHub:

1. **Find an issue** with the `good first issue` label — or browse the issue
   list and ask which issues are beginner-friendly.
2. **Comment to claim it** — say you're working on it so nobody else picks up
   the same issue.
3. **Ask questions on the issue** — maintainers monitor them and will point
   you at the relevant files.
4. **Open a PR** using the PR template. Keep it small; a focused fix or docs
   improvement is ideal.
5. **Expect a maintainer ping** — see the Review SLA below.

A good first issue is scoped so you can land it in one sitting. If it turns
out bigger than it looked, say so on the issue and it will be split.

## Development Setup

```bash
git clone https://github.com/forrestbthomas/pi-bulletin.git
cd pi-bulletin
npm install
```

The extension runs inside [Pi](https://pi.dev/) via `pi install file:/path/to/pi-bulletin`
(or `npm:pi-bulletin` once published). The launcher (`scripts/start-team.py`)
needs `tmux` and `pi-run` on PATH; it is Python stdlib-only, so no pip install
is needed.

## Testing

```bash
npm test                              # vitest: store + extension tests
npm run typecheck                     # strict TypeScript check of extension + store
python3 scripts/test_bulletin_watchdog.py   # watchdog stall-detection tests (stdlib unittest)
```

A live smoke run of the launcher (no API cost):

```bash
./scripts/start-team.py --team smoke --dryrun
```

This starts two fake-agent panes — press `Ctrl-b d` to detach when done, then
`tmux kill-session -t smoke`.

## Commit Style

- Small, focused commits (one logical change each).
- Prefix: `feat:`, `fix:`, `docs:`, `chore:`, `test:`, `ci:`,
  `release(vX.Y.Z):` — see `git log --format=%s` for current practice.
- Reference issues/PRs where relevant (`Refs #1`, `Closes #2`).

## Versioning policy

This is a 0.x SPIKE package; per semver, anything can change until 1.0.

- **0.x minor** — any user-visible change (feature, behavior change, new
  tool). BREAKING changes are flagged in CHANGELOG.
- **0.x patch** — fixes to shipped behavior only, never features.
- **Post-1.0** — strict semver: breaking = major, additive = minor, fix =
  patch. SECURITY's supported-versions table is bumped in the same PR as the
  CHANGELOG entry.

## Security

See `SECURITY.md` for reporting vulnerabilities. Never commit API keys or
tokens. A gitleaks pre-push hook is installed machine-wide on the maintainer's
setup (see `AGENTS.md`) and blocks pushes that contain secrets — assume CI and
reviewers check too.

## License (MIT-in / MIT-out)

pi-bulletin is licensed under the [MIT License](LICENSE). By submitting a pull
request or patch you agree that your contribution is offered under the same
MIT license (MIT-in), and the project's distributed output is MIT (MIT-out) —
code comes in under MIT and goes out under MIT.

## Issue and PR conventions

- Use the issue templates (`.github/ISSUE_TEMPLATE/`) for bug reports and
  feature requests.
- Use the pull request template (`.github/PULL_REQUEST_TEMPLATE.md`) — fill in
  the summary, test plan, and checklist.
- Add a dated `## [x.y.z]` entry at the top of `CHANGELOG.md` for any
  user-visible change.

## Review SLA

Maintainers aim to review or respond to pull requests within **7 days** of
submission (mirroring the [security response SLA](SECURITY.md)). If your PR has
been quiet longer than that, ping it with a comment — we'd rather triage than
leave you hanging.

## Releases

Main uses squash merges, which rewrite commit hashes. **The release tag must be
created from the merged main tip, never from a local commit that has not yet
landed** — otherwise the tag is not an ancestor of `main`. Correct order:

1. Merge all release commits (including the CHANGELOG entry) via PR.
2. Ensure local main is current: `git fetch origin && git pull --ff-only origin main`.
3. Publish to npm **from local main** (recommended — lets the maintainer use
   their npm credentials/security key):

   ```bash
   npm publish --access public
   ```

   If CI publishing is preferred instead, add an `NPM_TOKEN` secret with
   publish rights; the Release workflow then publishes with provenance.
4. Tag the merged tip and push it — the Release workflow verifies the tag is
   an ancestor of `main` and creates the GitHub release (npm publish in the
   workflow runs only when `NPM_TOKEN` is configured):

   ```bash
   git tag -a vX.Y.Z main && git push origin vX.Y.Z
   ```

## Syncing after a merge

After a PR is squash-merged, sync local `main` with a **fast-forward only**:
`git fetch origin && git checkout main && git pull --ff-only origin main`.
Never use `git reset --hard` as a routine sync — it destroys local work if
`main` has diverged. Reset is only justified when upstream rewrote local
history (squash collapse) with no unique local commits, and only with explicit
maintainer confirmation.
