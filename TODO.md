# TODO

Status snapshot, most recent work at the top. See `PLAN.md` for the full decisions
log (D1–D58) and architecture; this file is the scannable done/pending list.
`ROADMAP.md` is the longer-horizon direction.

## Done

- [x] **D41 + D42 + D45 + D46's user-token scopes confirmed live** (`channels:read`/
      `groups:read`/`im:read`/`mpim:read`, `im:write`, `files:write`,
      `reactions:write`, `search:read`) — the manual Slack app reauthorization this
      item had been waiting on had evidently already happened (likely alongside
      D56's Public Distribution reinstall). Live-verified 2026-10-26 with real,
      cleaned-up-after-itself calls: `users.conversations` (D41),
      `conversations.open`/a real `cli/dm.js --as-user` send + `cli/update.js
      --as-user` edit, both deleted after (D42), `files.getUploadURLExternal`
      (D45), `reactions.add`/`reactions.remove` on a disposable self-DM test
      message (D46), and `search.messages` (backfilled `search:read`). Also
      confirmed a bot-token edit of the user-authored test message correctly
      fails (`cant_update_message`) — Slack's same-author protection working as
      documented. **Found and fixed a real gap while verifying**: `cli/delete.js`
      had no `--as-user` flag at all, unlike every other CLI command — added.
      `USER_TOKEN_DM_SUPPORT_PLAN.md`'s remaining checklist items are now closed.
- [x] **`tsb-setup` bin entry added, closing the gap D57 left open (D58)** — the
      very next command `cli/tenants.js add` tells a global-install user to run
      had no direct command either. Verified with evidence, not assumed: real
      `slack-config.json` has no `tenancy` key; `resolveAccount()` against that
      real config resolves `single` with identical object references, not just
      equal values; live `node cli/doctor.js --json` against the real Hornblower
      install still reports working `botAuth`/`userAuth` and
      `slackbotMcp.enabled:false`, unchanged by D53–D57; `tsb-setup init`
      exercised from a real packed-and-installed copy, same methodology as D57.
- [x] **`bin` entries for `tsb-tls`/`tsb-tenants`/`tsb-get-user-token`/
      `tsb-get-workspace-token` (D57)** — caught before publishing: D54/D56 added
      these four scripts but `package.json`'s `bin` still only had
      `team-slack-bridge`/`tsb-hook`, so a global `npm install` couldn't run them
      directly. `get-user-token.js`/`get-workspace-token.js` gained the shebang
      line `bin` requires. README/FEATURES.md updated to show both the git-clone
      (`node cli/tls.js ...`) and global-install (`tsb-tls ...`) forms side by
      side everywhere one of these four is mentioned.
- [x] **Public Distribution activated; self-signed local HTTPS listener for the
      OAuth redirect callback (D56)** — Hornblower and Anchor OS turned out to be
      genuinely separate Slack orgs (not Enterprise Grid siblings), so installing
      the shared app into Anchor OS needed Slack's Public Distribution switched
      on. The only blocker (confirmed live) was the registered
      `http://localhost:8917/callback` redirect URL — Slack's distribution check
      doesn't exempt `localhost` the way Socket Mode exempts every other
      feature's Request URL. Fixed with `core/local-tls.js` (self-signed cert via
      the system's `openssl`, no new dependency; Let's Encrypt ruled out — it
      can't certify `localhost` at all) and moving `get-user-token.js` to
      `node:https`. New `get-workspace-token.js` captures a **bot** token for
      installing into a brand-new workspace, pairing with `cli/tenants.js add`.
      `cli/tls.js generate|path` wraps it. 6 new tests
      (`test/local-tls.test.js`), full suite still green.
- [x] **Display-name matching in `slack_resolve_user`/`resolveMentions` (D55)** —
      an optional `displayName` per configured user (e.g. `@PJ`) resolves as a
      fallback, only when `name`/`slackHandle`/`slackUserId` don't match. Two
      users sharing a `displayName` refuses as `ambiguous-user`, never picked.
      Config-only, synchronous, no network call — unchanged from before this.
      7 new tests (`test/display-name.test.js`).
- [x] **Multi-tenancy Phase 2, hand-provisioning half: `core/tenant-store.js` +
      `cli/tenants.js` (D54)** — `"multi"` mode now really resolves a Slack
      `team_id` to that tenant's own `env`/`config`/`dbPath` (previously D53's
      placeholder refused everything). Store maps `team_id → home directory`,
      same shape as the local account registry (D21), reusing
      `loadContextForHome()` — no tenant secret ever enters `tenants.json`
      itself. `cli/tenants.js add|list|remove` mirrors `cli/accounts.js`.
      Adversarial cross-tenant test added (`test/tenancy.test.js`). OAuth
      self-serve install flow remains deferred, unstarted, on purpose.
- [x] **Multi-tenancy Phase 1: `resolveAccount()` + `tenancyMode` scaffold (D53,
      ROADMAP.md's multi-tenancy plan)** — `core/tenancy.js` is now the one seam
      `mcp/http.js` resolves `{ env, config, dbPath }` through. `single` mode
      (default) is byte-identical to pre-refactor behavior (same object identity,
      not just equal values, asserted by test). `multi` mode is a validated config
      value that refuses every `/mcp` call, including `initialize`, rather than
      silently acting like `single` — there is no tenant store yet. Phase 2 (tenant
      store + `cli/tenants.js` + later an OAuth self-serve flow) is next, not
      started.
- [x] **`cli/lookup-user.js` — CLI wrapper for `slack_lookup_user` (D52)** — same
      `--as-user` convention as every other CLI command: absent selects the bot
      token, `--as-user` selects `SLACK_USER_TOKEN`/`tokenSource:"user"`.
      `--mode`/`--include-email` map straight through. Live-verified against the
      real workspace for both token sources.
- [x] **`slack_lookup_user` widened to accept either token via explicit
      `tokenSource:"bot"|"user"` (D51)** — never a silent fallback either
      direction. `users:read`/`users:read.email` added to the **user** token
      scope list too (bot side already had them from D50). Live-verified: all
      six combinations (bot/user × id/email/handle) succeeded against the real
      workspace.
- [x] **Live Slack-directory lookup: `slack_lookup_user` (D50)** — a NEW,
      separate capability from `slack_resolve_user` (which stays config-only,
      untouched). Resolves anyone in the workspace via `users.info`/
      `users.lookupByEmail`/paginated `users.list`, matched/normalized the same
      way as the config resolver. Ambiguous matches refused, never guessed;
      email hidden unless `includeEmail:true`; `users.list` pages cached
      in-memory per token (never a failed page); local-only by construction
      (absent from `mcp/tools.remote.js`'s import graph); never writes to
      `slack-config.json`.
- [x] **`anonymousMessage` per-install config default (D49)** — `botSend.
      anonymousMessageDefault` (off unless set). An explicit per-call `true`
      *or* `false` always overrides the config default; only an
      omitted/`undefined` argument falls back to it.
- [x] **`viaBot:true` authorization gate + threaded sender tracking DM (D48)** —
      refused from an unidentified sender unless `anonymousMessage` resolves
      true. An identified sender always gets a private "You have sent... via
      Bot" tracking DM (thread parent) with the real text as a threaded reply,
      even in anonymous mode. Bot-token edit/delete propagates to that tracking
      copy. Opt-out via `botSendTracking.enabled:false`.
- [x] **`slack_post`/`slack_reply`/`slack_dm` default to sending AS THE LOCAL
      USER, not the bot (D47)** — `viaBot:false` (new default) sends with
      `SLACK_USER_TOKEN`, same path as the pre-existing `_as_user` tools, so the
      message is really the sender's own (visible to them, native Slack
      edit/delete). `viaBot:true` opts back into the bot path, with a visible
      attribution footer and a `local_audit` journal entry.
- [x] **Reaction removal + as-user reactions (D46, PLAN.md decisions table)** —
      `core/post.js`'s `unreact()` (mirrors `react()`, `reactions.remove` instead of
      `reactions.add`); `slack_unreact` joins `slack_react` in both local and remote
      registries (bot reactions were already remote-safe); `slack_react_as_user`/
      `slack_unreact_as_user` are local-only. Remote tool count is now 10, not 9 — every
      stale "9-tool" reference updated. Caught before commit: the new as-user reaction
      tools needed `reactions:write` on the user token scopes too, which was missing
      entirely (reactions were bot-only before this change).
- [x] **File/attachment uploads (D45, PLAN.md §17)** — `core/files.js`'s `uploadFile()`
      on Slack's current 3-step flow (`files.getUploadURLExternal` → raw `POST` of the
      bytes to a non-`slack.com` URL → `files.completeUploadExternal`, which can share
      straight into a `channel`/`threadTs`). New `slack_upload_file`/
      `slack_upload_file_as_user` MCP tools + `cli/upload.js`, local-only for two
      reasons (token identity AND arbitrary local-file-read). New `files:write` scope
      added to both bot/user token scopes. The `slack-bridge` skill's push-mr-to-slack
      workflow gained an optional "attach evidence" step using the same identity that
      posted the announcement.
- [x] **Local state file permissions hardened (D44, PLAN.md §16, security audit finding)** —
      `.env` was `0644` on a real machine despite the code writing `{ mode: 0o600 }`;
      `writeFileSync`'s `{ mode }` only applies on creation, not on overwriting an
      existing file, so it never actually self-healed. `slack-config.json`/`accounts.json`/
      `repos.json` had neither half of the protection at all, and `slack-config.json`
      holds real PII (38 people's names/handles/Slack IDs). Fixed with an explicit
      `chmodSync(path, 0o600)` on every write, in addition to the create-only `{ mode }`
      option, across all four write sites. New/extended tests assert the actual file
      mode after starting from a deliberately `0644` file — the only case where a
      passing `{ ok: true }` result proves nothing about the bug.
- [x] **v0.1.7 published to npm (2026-10-22)** — not via the new OIDC workflow, which hit
      a real `E404` both times it ran (provenance signs fine, the registry PUT 404s
      regardless, matching a confirmed open upstream bug, `npm/cli#8730`/`#8976`).
      Separately confirmed root cause: the local npm session's own auth token was
      invalid (`npm whoami` → 401), not a Trusted Publisher misconfiguration — npm
      returns 404 instead of 401 for an unauthenticated publish attempt, which looks
      identical to the OIDC failure. Published manually via `npm login` (OTP
      browser-approval) + `npm publish`. The workflow itself needs a real retry on the
      next release to know whether the OIDC path is actually fixed now or still broken.
- [x] **npm publish via GitHub Actions + OIDC Trusted Publishing (D43, PLAN.md §15)** —
      `.github/workflows/publish.yml`, triggered only by a pushed `v*` tag, never by a
      push to `main` (explicit owner request). No `NPM_TOKEN`; the owner's existing npm
      Trusted Publisher registration needed exactly this workflow filename to have
      anything to fire against. Runs `npm ci`/`npm test`, checks the tag matches
      `package.json`'s version, then `npm publish --provenance`.
- [x] **`slack_list_channels` tool (D41, PLAN.md §13)** — "what channels am I in" answered via
      `core/channels.js`'s `listMyChannels` on `users.conversations` (not `conversations.list` — that
      enumerates the whole workspace regardless of membership, the same over-broad shape D20 already refused
      for `resolveUser`). User-token-gated, local-only like `slack_search`. Checked for duplication first:
      `core/doctor.js`'s `findChannelByName` and `verify-dm.js` both call Slack list methods too, but on the
      bot token and scoped to one already-configured channel name / the bot's own open DMs respectively —
      neither is "every channel the human user is in," so this is new, not a duplicate.
- [x] **DM-as-user fix (D42, PLAN.md §14, found mid-flight from another session)** — `core/dm.js` was opening
      a bot-token DM even for `asUser` sends, and caching it under a key a user-token send would also hit;
      fixed with cache keys namespaced by a token fingerprint (bot/user mode + a one-way hash of the token),
      not just a mode label — a GPT-5.6 Terra review caught that the mode-label-only version would still
      collide across a rotated/re-authorized token against the same `TSB_HOME`. Added `slack_dm_as_user` and
      `slack_update_message_as_user`, both local-only. Also fixed on the way: `config/slack-app-manifest.
      template.json`/`get-user-token.js` were missing the `im:write` user scope `conversations.open` actually
      needs as a user, D41's four read scopes, and a `search:read` the manifest already listed but
      `get-user-token.js` never requested.
- [x] **Fixed 5 should-fix issues from a GPT-5.6 Terra (India, medium) review of D41/D42 before push** — the
      token-fingerprint cache-key fix above; `dm()`-boundary regression tests (not just `resolveDmChannel()`
      directly); README/FEATURES.md documented only `chat:write` as a user scope (now the full 7-scope list);
      `USER_TOKEN_DM_SUPPORT_PLAN.md` was linked from shipped docs but missing from `package.json`'s `files`;
      `package-lock.json` and three hardcoded MCP `serverInfo.version` strings had drifted to `0.1.0` across
      several real version bumps — all three now read a new `core/version.js` helper (which `core/home.js`'s
      App Home version line also now uses, instead of duplicating the same read-package.json code). Also ran
      `npm audit fix` while touching the lockfile — resolved an unrelated critical `proxy-addr` advisory.
- [x] Away mode, harness-agnostic (D39/D40) — policy moved out of harness config into
      `core/away-policy.js` + `awayMode.*` in `slack-config.json`; adapters now only
      translate (`cli/hook.js` for Claude Code, `adapters/opencode-plugin.js` for
      OpenCode). `cli/hooks-install.js claude|opencode` writes each harness's own config,
      merging rather than clobbering. Fixed on the way: `hookTimeoutSeconds` was read by
      `core/hooks.js` but never normalized by `loadConfig`, so it silently did nothing.
  - Fail mode is now per-harness (D39): Claude defers to the local prompt, everything
    else denies. Unknown harnesses default to deny.
- [x] Away mode (D34–D38) — Claude Code hooks (`tsb-hook preToolUse|stop|preCompact|
      notification`) route a local session's approvals to Slack, gated by a `.away` flag
      file (`cli/away.js on|off|status`). Includes the WAL + `busy_timeout` db fix (D37)
      that concurrent asks require.
  - `PreCompact` is announce-only (D38) — "block autocompact until I approve" is not
    achievable with hooks.

## Pending

- [ ] **D47's `viaBot:false` default needs `SLACK_USER_TOKEN` configured on every
      developer's machine to work at all** — anyone who hasn't run `npm run
      get-user-token` yet will see `slack_post`/`slack_dm` start failing with
      `user-token-required-pass-viaBot-true-to-send-as-the-bot-instead` where
      they used to silently succeed as the bot. Intentional (that's the whole
      point of D47), but a real rollout step for every existing install, not
      just a code change.
- [ ] **D48's tracking DM relies on the sender's own `owner.slackUserId` being
      DMable by the bot** — never live-verified against a real workspace; only
      unit-tested against fake tokens so far.
- [ ] **Multi-tenancy: actually install into Anchor OS, then live dogfood against
      a real public `/mcp` endpoint — not started.** Public Distribution is now
      active (D56), so the install itself is unblocked: run
      `node cli/tenants.js add <ANCHOR_OS_TEAM_ID>`, then
      `TSB_HOME=<printed home> node get-workspace-token.js`, approve the
      authorize URL while logged into anchoros.slack.com. `cli/tenants.js` +
      `core/tenant-store.js` (D54) are unit-tested but never exercised against a
      real deployed HTTPS endpoint with two real Slack workspaces' signed
      requests. This is step 3 of ROADMAP.md's plan, and the self-host/
      managed-shared offering (step 4) is deliberately blocked on it.
- [ ] **Multi-tenancy: OAuth self-serve install flow — not started, deferred on
      purpose.** `cli/tenants.js` (hand-provisioning) covers onboarding until an
      actual company asks to self-onboard; see ROADMAP.md for why this is
      sequenced after, not dropped.

- [ ] **Away mode end-to-end verification — never run.** 228 unit tests pass, but no part
      of away mode has been exercised against a live daemon with a human tapping buttons.
      Specifically unverified: subagent attribution with two concurrent asks, fail-open-fast
      with the daemon stopped, the `Stop` continuation cap, and whether
      `~/.claude/settings.json`'s pre-existing hooks still work after an install.
- [ ] **OpenCode `session.idle` is unproven.** The adapter throws to mean "continue with
      this instruction from Slack". OpenCode documents `throw` for `tool.execute.before`;
      whether an *event* handler can steer a session the same way has not been tested. If
      it cannot, OpenCode has no Stop equivalent and that should be stated rather than
      shipped as if it works.
- [ ] Codex and Gemini adapters — `failMode` already classifies them (deny), and
      `core/acp-backends.js` already supports them on the ACP axis, but no hook/plugin
      adapter exists.
- [x] Core posting/DM/scheduling/reactions/progress-messages, CLI + local MCP server
      (stdio, full tool set) + Slack `skill/SKILL.md`
- [x] Human-in-the-loop `ask`/approve primitive (DM-based, button + free-text capture)
- [x] Locked-down remote/hosted Slackbot MCP profile (D5/D5a/D5b/D20) — built, not
      currently deployed (`slackbotMcp.enabled: false`)
- [x] Local multi-account support (D21) + shared local MCP HTTP daemon (D22)
- [x] Security-audited (no secrets, no lifecycle scripts, `npm audit` clean),
      installed globally and verified working on this machine. Published to npm as
      `team-slack-bridge` — `0.1.0`, `0.1.1`, `0.1.2`, `0.1.4` are live on the
      registry; `0.1.5` carries everything after the `0.1.4` publish (id-based
      close/reopen, the codex-review lifecycle fixes, the README overhaul, the
      App Home redesign). `0.1.6` added away mode (D34–D40). `0.1.7` adds
      `slack_list_channels` (D41) and the DM-as-user fix (D42) — live on npm, published
      manually (see D43's publish-workflow note above). `0.1.8` fixes local state file
      permissions (D44). `0.1.9` adds file/attachment uploads (D45). `0.1.10` adds
      reaction removal + as-user reactions (D46).
- [x] Fixed npm-distribution-specific bugs: config cold-start path defaulting inside
      the install dir (would get wiped by `npm update`), `bin` path convention,
      `build:sea` correctly scoped to repo-clone-only
- [x] **ACP-driven Slack thread sessions — all 4 planned phases, plus review fixes:**
  - [x] Phase 1: named repo registry (D23), owner+allowlist start gate (D24), ACP
        client on `@agentclientprotocol/sdk` (D27), fs/terminal serving scoped to the
        repo, permission requests rendered as in-thread Approve/Deny (not DM),
        debounced progress rendering, `/agent-session start` slash command
  - [x] Phase 2: `@mention` keyword trigger, message-shortcut trigger (modal)
  - [x] Phase 3: `--model name`, fully protocol-driven via `session/new`'s
        `configOptions` (D28) — no hardcoded per-backend model tables
  - [x] Phase 4: session survives a listener restart via `session/resume` or
        `session/load`, whichever the backend advertises (D29)
  - [x] Stop rights separated from start rights (D30/D31) —
        `agentSessions.allowedControllers` is a distinct grant from `allowedUsers`;
        typing `stop`/`exit` in a session's thread closes it, no slash command needed
  - [x] Pre-publish review fixes (D32): `.env` credentials weren't reaching the
        spawned backend process at all (silent Bedrock/API-key failure); no error
        handling around session start/resume (stuck-forever "starting…" message);
        symlink escape past the repo boundary check; race condition on two rapid
        replies both trying to resume the same thread (`withKeyLock`)
  - [x] Live-testing fixes (D32/D33 follow-ons): approval-kind asks were capturable
        by plain free text (silently denying a pending approval); the very first
        prompt of a new session wasn't lock-protected against a concurrent reply
  - [x] D33: a DM directly to the bot can start a session too (mention keyword
        doesn't apply in a DM context)
  - [x] `cli/agent-session.js list` — see recorded sessions (ACP or manual),
        filterable by status/kind
  - [x] `/agent-session reopen <id>` — deliberately bring back a session you
        closed on purpose (stop/exit/close all persist `status:'closed'`, which
        tryResumeSession refuses on sight by design); just flips the DB row back
        to `active` so the next reply in its original thread resumes it normally
  - [x] `/agent-session close <id>` / `close all` — found live that Slack slash
        commands NEVER carry `thread_ts` (confirmed against Slack's own docs:
        developer slash commands can't be invoked inside threads at all), so the
        original `/agent-session close` (assumed it could read the thread it was
        run from) could never actually work; replaced with id-based close plus a
        close-all-in-this-channel option, D31-gated per session
- [x] **Live-verified on this machine**: Socket Mode listener connected, DM from the
      bot to the owner, an ACP session started against the `dashboard` repo
      (`/Users/Manish.Sharma/hornblower/UI/dashboard`), one session per thread with
      working follow-up replies, Claude via Bedrock (`CLAUDE_CODE_USE_BEDROCK=1`) and
      OpenCode (native `AWS_REGION` detection, OpenCode Zen credentials) both
      confirmed reachable as backends
- [x] **Thread replies post as a new message per turn** instead of editing the first
      "starting…" message in place (was the default for every reply after the first)
- [x] **Per-user repo scoping** (`agentSessions.repoAccess`) — `allowedUsers` grants
      the right to start/resume sessions at all; which named repos a given user may
      point one at is now a separate, optional, backward-compatible grant
- [x] **Trusted-app DM triggers** (`agentSessions.trustedApps`) — a specific Slack
      app (`bot_id`/`app_id`) can DM-trigger a session on a named human's behalf,
      scoped to DMs only (a review pass caught and fixed a first version that
      accidentally granted channel-wide session control instead)
- [x] **Multiple DM/mention trigger aliases** (`agentSessions.mentionKeywords`) —
      e.g. both `"start session"` and `"@etd start session"` can trigger the same way
- [x] **Context-limit handoff**: ACP's `usage_update` (real `used`/`size` token
      counts, not a heuristic) is tracked per turn; crossing
      `agentSessions.contextWarningThreshold` (default `0.8`) has the agent
      self-summarize, writes a handoff file under `~/.team-slack-bridge/handoffs/`,
      and gates further replies until the user picks `here` (fresh session in-thread,
      seeded from the handoff), `new thread` (manual), or `compact` (best-effort
      nudge — ACP has no real on-demand compaction request, confirmed against the
      SDK schema; only an agent-initiated `compaction_update` notification exists,
      which is also now wired up)
- [x] **`rewind`** — approximates a rewind/checkpoint ACP does not actually have
      (confirmed: no such method or concept anywhere in the protocol) by asking how
      far back and how much detail, then starting a fresh session seeded from the
      bridge's own saved transcript of the last N exchanges
- [x] All of the above went through several rounds of `opencode --agent sol` review,
      which caught and fixed: `core/identity.js`'s config loader silently dropping
      every one of the new `agentSessions.*` fields above (so none of them would have
      worked at all without this catch); `new thread` not actually closing the
      session; rewind seeding a fresh session from an empty transcript or a failed
      internal summary; a race between `closeAgentSession` and the new
      here/rewind session-replacement flow (now share the same per-thread lock);
      `here`/`new-thread`/`rewind` bypassing the D31 close-rights check
      (`closeAgentSession` already enforced this; the new flows initially didn't)

## Pending / known gaps

- [ ] **Idle/abandoned session cleanup** — a session nobody ever runs `/agent-session
      close` (or types `stop`/`exit`) on stays `status:'active'` in the DB and its
      backend connection process keeps running indefinitely. No idle-timeout exists.
      Real operational gap for a long-running install.
- [ ] **No max-concurrent-sessions cap / rate limiting** on how many ACP sessions can
      be open at once — each is a real spawned backend process (well, one process per
      *backend name*, but unbounded sessions multiplexed onto it).
- [ ] **Per-backend model `configId`/value strings unverified for Codex and Gemini
      CLI** — only Claude (Bedrock) and OpenCode have been exercised live so far;
      Codex/Gemini's actual `session/new` `configOptions` shape is unconfirmed.
- [ ] **`amazon-bedrock/us.openai.gpt-5.6-luna` returned a server error** (ref
      `err_0b3fcc4f`) during one live attempt via OpenCode — unclear if transient
      (Bedrock/OpenCode-side) or a real gap; worth re-testing before relying on it.
- [ ] **Antigravity (`agy`) backend** — no confirmed ACP support found in research;
      deliberately not built. Revisit if `agy --help`/docs later show an ACP mode.
- [ ] **Local MCP HTTP daemon (D21/D22)** — unit-tested, not live end-to-end verified
      (needs a second real MCP client actually connecting over HTTP).
- [ ] **Remote/hosted Slackbot MCP profile** — fully built (D5/D20) but never actually
      turned on/deployed publicly; still `slackbotMcp.enabled: false`.
- [ ] **No automated test for real `session/resume`/`session/load` RPCs** against a
      live backend — only the guard-clause/safety logic (D24 gate, closed-session
      rejection, missing-metadata rejection) is unit-tested. The actual resume
      mechanics were confirmed live during manual testing, not via `npm test`.
- [ ] **FEATURES.md has no dedicated ACP section** — the write-up lives entirely in
      `README.md`'s "ACP agent sessions" section; FEATURES.md's per-feature format
      doesn't have a matching entry. Minor doc-consistency gap, not a code gap.
- [ ] **Message-shortcut manifest entry** requires manually merging into each
      deployed Slack app's manifest — no automated "push this update to my live app"
      tooling exists (by design — this repo doesn't hold Slack API app-management
      credentials).
- [ ] **No live testing of the context-limit handoff / rewind / trusted-app DM
      paths** — all covered by unit tests against fake ACP sessions, none run against
      a real Slack workspace or a real backend process. Highest-risk untested
      surface right now: whether a real backend actually emits `usage_update` in
      practice, and the `here`/`new thread`/`compact`/`rewind` Slack message flows.
- [ ] **`contextState`/`handoffPath`/`transcript`/`pendingRewind` are in-memory only**
      — a listener restart mid-context-limit-gate (or mid-rewind Q&A) loses that
      state entirely; the session just resumes normally, ungated, no follow-up
      questions pending. Same lazy-resume tradeoff as D29, just not called out
      separately before now.
