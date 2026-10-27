# Implementation handoff: Plain-English cross-company messaging

Paste everything below into a new session to start implementation.

---

## Repo and context

Work in `/Users/Manish.Sharma/hornblower/team-slack-bridge` (git repo, `main` branch,
public on GitHub as `manish96170/team-slack-bridge`, also published to npm as
`team-slack-bridge`). This is a Slack bridge library: CLI scripts + a local/remote MCP
server, built as thin adapters over plain functions in `core/`.

**Read these three files first, in this order, before writing any code:**
1. `ROADMAP.md`'s **"Plain-English cross-company messaging"** section — the full
   design for this feature. This is the spec.
2. `PLAN.md`'s decisions table (`D1`–`D63`) and its note pointing at the roadmap
   section above — skim it for conventions (how decisions get logged, how `core/`
   functions are shaped, the "no ambient state" rule, the `_as_user` alias pattern).
   Specifically read `D21` (`core/accounts.js`, the name→home registry this feature
   reuses) and `D54` (`core/tenant-store.js`, the registry this feature must stay
   separate from) in full.
3. `TODO.md`'s matching pending item (search for "Plain-English cross-company").

## The task, in one paragraph

Let a human (or the `skill/SKILL.md` natural-language skill) send a DM by saying
something like "DM pulkit.jain in anchor: hi" — resolving `anchor` to a registered
local account (`core/accounts.js`, already built) and `pulkit.jain` to that account's
real Slack user ID via a live directory lookup (`core/directory.js`'s `lookupUser`,
already built) — or, with a configured default account, just "DM pulkit.jain: hi"
with no company named at all. If no company is named **and** no default account is
configured, the underlying tool must refuse with a specific, distinct error code so
the skill layer (not application code) can ask the user which company, rather than
guessing.

## What already exists — read the actual source before assuming anything

- `core/accounts.js` — `listAccounts()`, `resolveAccountHome(name)` (name omitted →
  registered default; unregistered name → `{ ok:false, error:'account-not-found' }`),
  `loadAccountContext(name)`, `addAccount`, `removeAccount`, `setDefaultAccount`.
- `core/directory.js` — `lookupUser({ query, mode, token, tokenSource, ttlMs })`,
  already handles ambiguous-match refusal (`error:'ambiguous-user'`, lists every
  match) and not-found. Do not reimplement this matching logic.
- `core/dm.js` — `dm({ botToken, userToken, userId, text, asUser, config, dbPath,
  dryRun })`.
- `cli/accounts.js` and `cli/lookup-user.js` — existing CLI wrappers over the above,
  useful as style references for the new `cli/dm-by-name.js`.
- `cli/lib/args.js`'s `parseFlags`/`output` — shared CLI arg parsing. Check whether
  `output()`'s dry-run branch (which assumes a Slack-call `request.method` shape) fits
  this feature's result shape or needs the same manual-output workaround
  `cli/archive.js` used (see that file for the pattern if `output()` doesn't fit).

## Build, in this order

1. **`core/people.js`** (new) — `dmByName({ accountName, personName, text, asUser,
   dryRun })`:
   - Resolve the account via `resolveAccountHome(accountName)`. If `accountName` is
     omitted and there is no registered default, refuse with a specific error code
     (suggested: `no-company-specified-and-no-default-configured`) — do not fall
     through to any other behavior.
   - `loadAccountContext` for that account's `env`/`config`.
   - Resolve `personName` via `lookupUser` (decide live-first vs config-file-first
     per the open question in ROADMAP.md — pick one, document why in the PLAN.md
     decision entry you add once this ships).
   - Send via `dm()` using the resolved account's token.
   - Return one combined result: resolved account name, resolved person (id/handle/
     displayName), and the send result — so a caller/log sees one action, not two.
2. **`cli/dm-by-name.js`** + `tsb-dm` bin entry in `package.json` (and the matching
   `"dm-by-name"` npm script, following the existing `tls`/`tenants`/`archive`
   pattern) — `--to "<name>" [--company <alias>] --text "<text>" [--as-user]
   [--dry-run] [--json]`.
3. **Tests** — `test/people.test.js` or `test/dm-by-name.test.js`, following the style
   of `test/archive.test.js` or `test/tenancy.test.js` (temp `TSB_HOME`, real
   assertions, no mocking of the thing under test). Cover at minimum: resolves and
   sends with an explicit `--company`; falls back to the registered default when
   omitted; refuses with the specific error code when no company is given and no
   default is configured; propagates `ambiguous-user` from `lookupUser` without
   swallowing it; `--dry-run` touches neither Slack nor the ledger.
4. **Verify against a real global install** before calling this done — `npm pack` →
   install into a clean `--prefix` → run `tsb-dm` from there. Every bin command added
   this cycle (`tsb-tls`, `tsb-tenants`, `tsb-setup`, `tsb-archive`, etc.) was verified
   this way; don't skip it for this one.
5. **`skill/SKILL.md`** — document the natural-language pattern and the explicit
   instruction: on `no-company-specified-and-no-default-configured`, ask the user
   which company before doing anything else.
6. **Docs** — `README.md` (a short section, same placement style as "Installing into
   another workspace" or "Database retention") and `FEATURES.md` (a `###` entry in its
   per-feature format). Add the `PLAN.md` decision entry (next free `D` number — check
   `PLAN.md`'s table for the current highest before picking one; another session may
   have added entries since this handoff was written) and mark the `ROADMAP.md`/
   `TODO.md` items done.

## Conventions to not violate

- **No ambient state in `core/`** — tokens and config are parameters, never a
  `process.env` read inside a `core/*.js` function.
- **Explicit beats inferred** — this whole feature exists to replace "guess the
  company" with "ask," never the other way around. Don't add a silent fallback
  anywhere this plan didn't already specify one.
- **This is a public repo** — never commit a real company name, workspace name,
  Slack team/app/client ID, or real email address in any example, test fixture, or
  decision-log entry. Use the existing placeholder conventions already in the repo
  (`config/slack-config.example.json`'s "Jane Doe"/`U0123ABC`/`jane.doe@example.com`,
  and `PLAN.md` D62's "Company A"/"Company B"/`T0123ABC`/`T0456DEF`).
- **Before every commit**: run `npm test` (full suite must stay green), `git fetch
  origin --tags` and compare against `HEAD` to catch concurrent work before pushing
  (this repo has had multiple sessions touch it in parallel — check `PLAN.md`'s
  highest `D` number against what you're about to write before assuming it's free),
  and confirm `gh auth status` shows the account with push rights active (it has
  drifted to a no-access account mid-session before).
- Bump `package.json`'s `version` with each meaningful commit, matching this repo's
  existing pattern (one bump per logical change, not batched).

## Not in scope for this pass

- The OAuth self-serve install flow (separate, already-deferred item).
- Making ACP agent sessions multi-account-aware (separate, already-tracked
  `ROADMAP.md` idea).
- Anything about the hosted `/mcp` tenancy resolution (`core/tenant-store.js`) — this
  feature must not touch that file or its resolution path at all.
