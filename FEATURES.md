# team-slack-bridge feature guide

This repo has one rule for optional surfaces: default off unless the feature is needed
and the Slack app/config pieces are deliberately enabled.

## Required baseline

Runtime:

```bash
nvm use
npm install
npm test
```

Minimum runtime is Node `>=26`; `.nvmrc` pins `26`.

Required files:

- `.env` — local credentials, never committed.
- `slack-config.json` — local/team routing config, never committed.

Bootstrap:

```bash
node cli/setup.js init
node cli/doctor.js --json
```

## Environment variables

| Variable | Required for | Default |
|---|---|---|
| `SLACK_BOT_TOKEN` | bot posts, DMs, reads, listener, HTTP MCP | required for real Slack calls |
| `SLACK_APP_TOKEN` | Socket Mode listener | optional |
| `SLACK_SIGNING_SECRET` | signed HTTP Events API, slash commands, Slackbot MCP | optional until those surfaces are enabled |
| `SLACK_USER_TOKEN` | local `--as-user` post/DM/edit/upload, local search, `slack_list_channels` | optional |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` | one-time user token OAuth helper | optional |

## Slack app setup

Start from:

```text
config/slack-app-manifest.template.json
```

Baseline bot scopes:

```text
app_mentions:read
channels:history
channels:read
chat:write
commands
files:write
groups:history
groups:read
im:history
im:read
im:write
reactions:write
users:read
users:read.email
```

Socket Mode also needs an app-level token with:

```text
connections:write
```

User token scopes (only if using any `--as-user`/`asUser` capability, local search, or
`slack_list_channels` — none of these are bot scopes, Slack requires them separately):

```text
chat:write
search:read
im:write
channels:read
groups:read
im:read
mpim:read
files:write
reactions:write
```

`get-user-token.js`/`npm run get-user-token` requests all of the above. Changing this list
requires reinstalling the app and re-running `npm run get-user-token` — an already-minted
`SLACK_USER_TOKEN` keeps whatever scopes it was minted with.

Slackbot MCP is separate. Only add this when exposing a public HTTPS `/mcp`
endpoint:

```text
mcp:connect
```

Also merge:

```text
config/slackbot-mcp.manifest.fragment.json
```

After changing scopes or manifest settings, reinstall the Slack app.

## Feature switches

### Bot posting

Default: on when `SLACK_BOT_TOKEN` exists, **for the CLI only**. The MCP tools
`slack_post`/`slack_reply`/`slack_dm` default to **off** since D47 (2026-10-25) — see
"Post as user (default, as of D47)" below; pass `viaBot:true` to those three tools to
opt back into this bot-sent behavior.

Use:

```bash
node cli/post.js --channel "#deploys" --text "build finished" --json
node cli/reply.js --channel "#deploys" --thread-ts "123.456" --text "done" --json
node cli/react.js --channel "#deploys" --ts "123.456" --emoji eyes --json
node cli/react.js --channel "#deploys" --ts "123.456" --emoji eyes --remove --json
```

Turn off: remove/withhold `SLACK_BOT_TOKEN`, or avoid using the commands/pass `viaBot`
only when meant.

### Post as user (default, as of D47)

Default (MCP `slack_post`/`slack_reply`/`slack_dm`): **on** — these three tools now
send with `SLACK_USER_TOKEN` unless called with `viaBot:true`, reversed from the
original bot-only behavior (PLAN §18/D47). The reason: a bot-token send is not a
message belonging to its human sender — they can't see it in their own history or
natively Edit/Delete it in Slack, and on a Bot Token shared across a team it carries no
indication of who sent it. Sending as the user fixes both by construction (it really is
their message). The CLI (`cli/post.js` etc., below) is unaffected by this and keeps the
original bot-default — enable with `--as-user` there as before. This asymmetry between
CLI and MCP defaults is deliberate, not an oversight: see PLAN §18.

Enable (user-token path, either surface):

```bash
npm run get-user-token
```

Use:

```bash
node cli/post.js --channel "#deploys" --text "from me" --as-user --json
node cli/react.js --channel "#deploys" --ts "123.456" --emoji eyes --as-user --json
node cli/react.js --channel "#deploys" --ts "123.456" --emoji eyes --as-user --remove --json
```

Turn off: remove `SLACK_USER_TOKEN` from `.env` (MCP `slack_post`/`slack_reply`/
`slack_dm` then fail clearly with `user-token-required-pass-viaBot-true-to-send-as-the-bot-instead`
rather than silently falling back to the bot).

Remote Slackbot MCP never exposes this (it has no user-token path at all, by design —
§11).

When sending `viaBot:true` anyway: refused outright
(`not-authorized-to-send-as-bot-pass-anonymousMessage-true-to-send-anonymously`) unless
this install can identify its sender (`owner.slackUserId` configured) OR
`anonymousMessage` resolves to `true` (D48 — closes the gap where an unconfigured
install could bot-spam anonymously by accident, not just by declared intent).
`anonymousMessage` is per-call (`true`/`false` always overrides) but also has a
per-install default — `"botSend": { "anonymousMessageDefault": true }` in
`slack-config.json` means `viaBot:true` sends are anonymous unless a caller explicitly
passes `anonymousMessage:false` for that one call (D49). When it
does send: the text gets a visible attribution footer —
`<@U...> (Name, @handle) · memberId: U...` — resolved from `slack-config.json`'s
`owner` (or `_sender withheld_` instead, if resolved anonymous), and the send is
journaled to a local `local_audit` SQLite table (`core/local-audit.js`/`core/sender.js`).
This is the local, trust-the-config-file equivalent of what the remote profile already
does with a signed identity (§11.3); see PLAN §18/§20 for the full reasoning and its
limits.

**If the sender is identified, they also get a private tracking copy — even in
anonymous mode** (`anonymousMessage:true` only hides identity from the recipient, never
from the sender's own record; D48, PLAN §19). The bot DMs them `"You have sent a DM to
<@user> via Bot"` / `"...a bot message in #channel via Bot"` as a thread parent, with
the actual sent text as a single threaded reply underneath — one line per send in their
own DM history, full content one click away. A bot-token `slack_update_message`/
`slack_delete_message` on the original propagates there too: edit touches only the
threaded reply, delete removes the whole tracking DM. Turn this specific piece off
(keep the attribution/audit, drop the DM) with `"botSendTracking": { "enabled": false }`
in `slack-config.json` — default is `true`. None of it runs on the as-user path above,
so that path's latency is unaffected either way.

### DM as user / edit as user

Default: DM/edit **as user** is now the default for `slack_dm` too (D47, same `viaBot`
flag as "Post as user" above). Requires `SLACK_USER_TOKEN`, and currently blocked live
by a missing scope — see "Known gaps" below.

Use:

```bash
node cli/dm.js --user U0123ABC --text "from me" --as-user --json
node cli/update.js --channel C0123ABC --ts "169…" --text "updated" --as-user --json
```

MCP: `slack_dm_as_user`, `slack_update_message_as_user` — separate, explicitly named
local-only tools, same reasoning as "Post as user" above for *editing* an existing
message (identity there is fixed by whichever token originally posted it, not a
runtime choice). `slack_dm` itself gained the `viaBot` boolean in D47 specifically to
flip its *default*, which is a different problem (which identity should a *new* send
default to) — see PLAN §18 for why that one tool broke the "never an ambiguous
boolean" rule on purpose. `core/dm.js` caches the opened DM channel per **caller identity**
(`bot:<userId>`/`user:<userId>`) so a bot-opened DM is never reused for an as-user send.

Turn off: remove `SLACK_USER_TOKEN`. Remote Slackbot MCP never exposes this.

**Known gap:** live `conversations.open` with a user token currently fails `missing_scope` until the
Slack app's user scopes include `im:write` and the app is reinstalled/re-authorized — the manifest
template and `get-user-token.js` request it, but that is a manual, one-time owner step not yet done
(see `USER_TOKEN_DM_SUPPORT_PLAN.md`).

### DMs

Default: available locally when bot token exists.

Use:

```bash
node cli/dm.js --user U0123ABC --text "can you check this?" --json
```

`core/dm.js` caches opened DM channel IDs in `.ledger.sqlite`.

Turn off: avoid local DM commands or remove bot DM scopes. Remote Slackbot MCP never
exposes DMs or ask/approval.

### Channel and thread reads

Default: available locally when bot has history scopes and is in the channel.

Use:

```bash
node cli/query.js --channel "#deploys" --limit 20 --json
node cli/thread.js --channel "#deploys" --thread-ts "123.456" --json
```

Remote Slackbot MCP can expose reads only if the tool is in `slackbotMcp.allowedTools`
and the channel is in `remote.readableChannels`.

### Search

Default: off unless `SLACK_USER_TOKEN` exists.

Use:

```bash
node cli/search.js --query "from:@someone deploy" --json
```

Turn off: remove `SLACK_USER_TOKEN`. Remote Slackbot MCP never exposes search.

### List my channels

Default: off unless `SLACK_USER_TOKEN` exists.

Use:

```bash
node cli/channels.js --json
node cli/channels.js --types "public_channel,private_channel,mpim,im" --json
```

MCP: `slack_list_channels` (`core/channels.js`'s `listMyChannels`). Uses Slack's
`users.conversations`, never `conversations.list` — the former only ever returns conversations the
*token's own user* already belongs to, so it can't be used to enumerate the whole workspace (PLAN D41).
`types` defaults to `public_channel,private_channel`; pass `mpim`/`im` explicitly to include group DMs
and 1:1 DMs. Not auto-paginated — pass the returned `response_metadata.next_cursor` back in as
`--cursor` for the next page.

Turn off: remove `SLACK_USER_TOKEN`. Remote Slackbot MCP never exposes this.

**Known gap:** requires the user token's `channels:read`/`groups:read`/`im:read`/`mpim:read` scopes,
which the manifest template and `get-user-token.js` now request but which need a manual
reinstall/re-authorize to take effect live — same outstanding step as "DM as user" above.

### Live directory lookup (PLAN D50)

Default: on whenever `SLACK_BOT_TOKEN` exists — this is a separate capability from
`slack_resolve_user` (above, under "Configured users"), which stays config-file-only,
fast, and deterministic, and is unaffected by any of this.

Use:

```text
slack_lookup_user { "query": "U055NFSGF88" }                       -> users.info
slack_lookup_user { "query": "manish.sharma@cityexperiences.com" } -> users.lookupByEmail
slack_lookup_user { "query": "@manish.sharma" }                    -> paginated users.list, matched
slack_lookup_user { "query": "Manish Sharma", "mode": "name" }     -> same directory search
```

Resolves a workspace member who is **not** necessarily in `slack-config.json`, via a
live Slack API call, using the shared **bot token only** — never a silent fallback to
`SLACK_USER_TOKEN` (every successful result carries `tokenSource: "bot"` so a caller
never has to guess). `mode` defaults to `"auto"`: a `U.../W...`-shaped query goes to
`users.info`, an email-shaped query goes to `users.lookupByEmail`, and anything else
searches the directory for an exact (normalized — one leading `@` stripped, trimmed,
case-insensitive) match against the Slack handle, `profile.display_name`, and real
name. Deleted users and bots are excluded by default. More than one match refuses with
`error:"ambiguous-user"` and lists every match — it never guesses, since Slack does not
guarantee a handle is globally unique. Email is omitted from the result unless
`includeEmail:true`, to minimize unnecessary PII exposure. `core/directory.js`'s
`users.list` walk is cached in memory per token for `directoryLookup.cacheTtlMs`
(`slack-config.json`, default 10 minutes) — a failed page is never cached, so a
`missing_scope` error is visible on the very next call, not silently repeated for the
whole TTL window.

Turn off: remove `SLACK_BOT_TOKEN`, or avoid calling the tool. `slack_doctor`'s
`directoryLookup.ready` reports whether the bot token is present (never the scope set —
that's only discoverable from a real `missing_scope` response at call time).

**Local-only**, same posture as `slack_list_channels`/`slack_search` — an unrestricted
directory search is a workspace-enumeration primitive the same way unrestricted
`resolveUser` was before D20, so it is absent from `mcp/tools.remote.js`'s import graph
entirely (checked by `test/http.test.js`), not just disabled by a flag.

**Never writes to `slack-config.json`.** A lookup is read-only by construction —
`core/directory.js` has no `configPath` parameter at all, and does not import
`core/config-write.js` (checked by `test/directory.test.js`). If "save this person to my
config" support is added later, it must be a separate, explicit, user-confirmed step
through the existing secure config-write path — never automatic.

**Known gap:** requires `users:read` (and `users:read.email` for email lookup) on the
**bot** token's scopes. The manifest template now requests both, but — same outstanding
step as every other scope addition in this file — needs a manual reinstall to take
effect against a live workspace; this has not yet been live-verified against a real
Slack API, only unit-tested against fake tokens.

### Scheduling

Default: available locally.

Use:

```bash
node cli/schedule.js --channel "#deploys" --text "standup" --post-at "2026-09-11T09:30:00+05:30" --json
node cli/scheduled.js --channel "#deploys" --json
node cli/unschedule.js --channel "#deploys" --scheduled-message-id Q123 --json
```

Remote Slackbot MCP does not expose scheduling.

### Human ask and approval

Default: local only.

Use:

```bash
node cli/ask.js --user U0123ABC --question "Deploy now?" --kind approval --json
node cli/ask.js --user U0123ABC --question "Which branch?" --kind question --capture-mode poll --json
```

Approval buttons require the Socket Mode listener. Free-text questions can use listener
or poll mode.

Remote Slackbot MCP never exposes ask/approval.

### Socket Mode listener

Default: off until started.

Requires:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`
- `owner.slackUserId` in `slack-config.json`

Use:

```bash
node cli/listen.js
```

Daemon mode:

```bash
node cli/daemon.js start --json
node cli/daemon.js status --json
node cli/daemon.js logs --lines 80
node cli/daemon.js stop --json
```

Turn off:

```bash
node cli/daemon.js stop --json
```

### HTTP Events API and slash commands

Default:

```json
"http": { "enabled": false, "port": 8917, "verifySlackSignatures": true },
"slashCommands": { "enabled": false, "outputModeCommand": "/outputmode" }
```

Enable in `slack-config.json`:

```json
"http": { "enabled": true, "port": 8917, "verifySlackSignatures": true }
```

Start:

```bash
npm run http -- --json
```

Endpoints:

```text
GET  /webhook
POST /webhook
POST /slack/events
POST /slack/commands
POST /mcp
```

Slack cannot reach `localhost`; use a public HTTPS tunnel or deployed host for Slack
Event Subscriptions and slash commands.

Turn off:

```json
"http": { "enabled": false, "port": 8917, "verifySlackSignatures": true }
```

### Output mode

Default:

```json
"outputMode": "medium"
```

Values:

```text
low
medium
high
```

Use locally:

```bash
node cli/output-mode.js low --json
node cli/output-mode.js medium --json
node cli/output-mode.js high --json
```

Slack slash command `/outputmode` requires slash commands to be enabled and configured
in the Slack app.

### Progress updates

Default: available locally.

Use:

```bash
node cli/progress.js start --channel "#deploys" --label "Deploy" --detail "starting" --json
node cli/progress.js update --channel "#deploys" --ts "123.456" --label "Deploy" --status running --detail "tests passed" --json
node cli/progress.js finish --channel "#deploys" --ts "123.456" --label "Deploy" --detail "released" --json
```

Text verbosity follows `outputMode`.

Remote Slackbot MCP does not expose progress mutation.

### File/attachment uploads

Default: available locally when the relevant token has `files:write`.

Use:

```bash
node cli/upload.js --file-path ./screenshot.png --channel "#deploys" --json
node cli/upload.js --file-path ./recording.mp4 --channel "#deploys" --thread-ts "123.456" --as-user --title "Before/after" --json
```

MCP: `slack_upload_file` (bot), `slack_upload_file_as_user` (user token). Uses Slack's
current `files.getUploadURLExternal` → raw `POST` → `files.completeUploadExternal`
flow — the old `files.upload` is deprecated. `--thread-ts` shares the upload straight
into a thread, e.g. evidence under an MR announcement posted by the `slack-bridge`
skill's push-mr-to-slack workflow.

Turn off: remove `files:write` from the relevant token. Local-only for two reasons —
the usual token-identity one, and because `filePath` reads an arbitrary local file, a
primitive that must never be exposed remotely. Remote Slackbot MCP never exposes this.

### App Home

Default: enabled in manifest template; publishing happens when users open the Home tab
through the Socket Mode listener.

Manual test:

```bash
node cli/home.js --user U0123ABC --dry-run --json
```

Remote Slackbot MCP does not expose App Home publishing.

### Agent sessions

Default:

```json
"agentSessions": { "enabled": false, "autoCreateSession": false, "provider": "none" }
```

Enable only when an agent/session orchestrator is ready:

```json
"agentSessions": { "enabled": true, "autoCreateSession": false, "provider": "openacp" }
```

Manual local record:

```bash
node cli/agent-session.js create --channel C0123 --thread-ts "123.456" --kind review-request --json
```

List recorded sessions (any kind — both this section's manual records and live ACP
sessions below share the same table):

```bash
node cli/agent-session.js list [--status active|closed|created] [--kind acp-session] [--limit 20] [--json]
```

Remote Slackbot MCP does not expose agent-session creation or listing.

**Not the same thing as ACP agent sessions** (README's "ACP agent sessions — a Slack
thread is a live session" section, PLAN D23–D27) — that feature reuses this same
`agentSessions` config block and the same `agent_sessions` table (via its `metadata`
column), but for a different purpose: a live, two-way ACP connection to a real coding
agent, gated by `agentSessions.allowedUsers` (D24) and started via `/agent-session
start`, an @mention with `agentSessions.mentionKeyword`, or a message shortcut — not
this section's manual local-record-only `cli/agent-session.js create`.

### OpenACP adapter

Default:

```json
"openacp": {
  "enabled": false,
  "adapterPackage": "@openacp/slack-adapter",
  "autoCreateSession": false
}
```

This is a dormant integration check only. Enabling it attempts to load the configured
adapter package; it does not add a hard dependency or change bridge behavior by itself.

### Slackbot MCP Client

Default:

```json
"slackbotMcp": {
  "enabled": false,
  "serverKey": "team-slack-bridge",
  "url": "",
  "authType": "slack_identity_auth",
  "authProviderKey": "",
  "exposeWriteTools": false,
  "allowedTools": [],
  "rateLimitPerMinute": 30
}
```

Enable only when:

- HTTP listener is enabled.
- `/mcp` is available on a public HTTPS URL.
- `SLACK_SIGNING_SECRET` is present; `/mcp` always verifies Slack signatures when enabled.
- Slack app has `mcp:connect`.
- Slack app manifest includes `mcp_servers`.
- `authType` is `slack_identity_auth`; actionable bridge tools require `_meta.slack`.
- `remote.postableChannels` and/or `remote.readableChannels` are intentionally set.

Example:

```json
"http": { "enabled": true, "port": 8917, "verifySlackSignatures": true },
"slackbotMcp": {
  "enabled": true,
  "serverKey": "team-slack-bridge",
  "url": "https://bridge.example.com/mcp",
  "authType": "slack_identity_auth",
  "authProviderKey": "",
  "exposeWriteTools": true,
  "allowedTools": ["slack_doctor", "slack_post", "slack_reply"],
  "rateLimitPerMinute": 30
},
"remote": {
  "postableChannels": ["C0123ABC"],
  "readableChannels": []
}
```

Remote-safe tools are structurally limited to:

```text
slack_post
slack_reply
slack_react
slack_update_message
slack_delete_message
slack_query_messages
slack_get_thread
slack_resolve_user
slack_doctor
```

Risky local tools cannot be enabled remotely by config.

Actionable remote calls are audited in `.ledger.sqlite` and rate-limited per Slack
caller. Remote post/reply require an `idempotencyKey`; remote update/delete only touch
messages that the same Slack caller created through the remote MCP path.

### Local MCP daemon + multi-account (PLAN D21/D22)

Local-only, separate from `slackbotMcp` above — not signature-gated, not restricted to
10 tools, never touches the remote/hosted profile (D6 unchanged).

Default:

```json
"localMcpDaemon": { "enabled": false, "port": 8918, "accountMode": "single" }
```

Enable to let multiple AI coding harnesses share one running server (binds
`127.0.0.1` only, hardcoded) instead of each spawning their own stdio `mcp/server.js`:

```bash
node cli/mcp-daemon.js start|stop|restart|status|logs
```

`accountMode: "single"` (default) behaves exactly like the stdio server — any
`account` argument naming a non-default account is rejected with a clear error, not
silently ignored. `accountMode: "multi"` additionally resolves an optional `account`
argument per tool call against `~/.team-slack-bridge/accounts.json`:

```bash
node cli/accounts.js add work --home ~/.team-slack-bridge-work
node cli/accounts.js list
node cli/accounts.js set-default work
node cli/accounts.js remove work
```

Each account is its own home directory with its own `.env`/`slack-config.json`/
`.ledger.sqlite` (run `TSB_HOME=<home> node cli/setup.js init` once per account to
populate it). Absent `accounts.json` entirely, every account-aware code path
synthesizes a single `"default"` account pointing at today's `TSB_HOME` — this feature
is fully opt-in and changes nothing for an existing single-account install.

### Away mode — approve your own local session from Slack (PLAN D34–D40)

Default: off (no `.away` flag file — hooks return immediately and prompting stays local).

Routes a session **you** started in your own terminal to Slack, so the laptop can be left
alone. This is the complement to ACP agent sessions, and the distinction matters:

| | Who starts it | How permissions reach Slack | Per-harness config |
| --- | --- | --- | --- |
| **ACP agent sessions** | the bridge, from Slack | in-process `onPermissionRequest` | none |
| **Away mode** | you, in your terminal | harness hook / plugin | written once by the installer |

A session the bridge did not spawn can never be adopted into ACP mid-way (D34): ACP
installs its permission callback at spawn, when the bridge owns the agent's stdio.

#### Setup

```bash
node cli/hooks-install.js claude   [--global|--project <dir>] [--json]
node cli/hooks-install.js opencode [--project <dir>] [--json]
```

Writes the harness's own config for you. For Claude Code it **merges** into
`.claude/settings.json` — safe alongside unrelated hooks you already have, and idempotent,
because it replaces only entries whose command contains `tsb-hook`. For OpenCode it writes
a small stub to `~/.config/opencode/plugins/tsb-away.mjs` re-exporting the packaged plugin.

Then toggle away mode whenever you like:

```bash
node cli/away.js on [--timeout-seconds 3600] [--max-continuations 3] [--json]
node cli/away.js status --json
node cli/away.js off
```

#### Policy lives in the bridge, not the harness (D40)

Adapters register for **all** tools and `core/away-policy.js` decides what to gate. Every
knob is read fresh from `TSB_HOME` on each invocation, so all of it takes effect
**mid-session with nothing to restart**:

| Knob | Where | Default |
| --- | --- | --- |
| on / off | `<TSB_HOME>/.away` via `cli/away.js` | off |
| which tools are gated | `slack-config.json` → `awayMode.gatedTools` | `Bash`, `Edit`, `Write`, `NotebookEdit` |
| ask timeout | `awayMode.hookTimeoutSeconds` | 300 |
| continuation cap | `awayMode.maxContinuations` | 3 |

`normalizeToolName` absorbs naming differences (Claude `Bash`/`Edit`, OpenCode
`bash`/`edit`), so one `gatedTools` list is correct for every harness.

#### What each event does

| Intent | Claude Code | OpenCode |
| --- | --- | --- |
| Gate a tool call | `PreToolUse` → Approve/Deny buttons | `tool.execute.before` → throw on deny |
| Ask what's next | `Stop` → free-text reply; `done`/`stop`/empty lets it stop | `session.idle` |
| Autocompact | `PreCompact` — informational only (D38) | `experimental.session.compacting` |
| Idle / waiting pings | `Notification` — fire-and-forget | — |

The `PreToolUse` DM names the tool, the cwd, and — when a subagent made the call — its
`agent_type`/`agent_id`, so parallel agents stay distinguishable on your phone.

#### ⚠️ The fail mode differs by harness (D39)

| Harness | On timeout / listener down / internal error |
| --- | --- |
| **Claude Code** | **defers** — no output, exit 0, falls through to the normal local prompt |
| **OpenCode, Codex, Gemini, anything unknown** | **denies** — the only signal available is `throw` |

Claude Code documents a third state ("exit 0 with no output means the hook has no decision
to report, so the tool call continues through the normal permission flow"). OpenCode has no
equivalent: throwing is a hard deny and there is no "ask locally instead". So a transient
network blip degrades to a local prompt on Claude and kills the turn on OpenCode. Unknown
harnesses default to **deny**, because a dead turn is recoverable and a silent approval
while nobody is watching is not. Nothing is ever silently approved on any harness.

#### Requirements and gotchas

- **The Socket Mode listener must be running** for approval buttons — a click is never
  visible to a poll. The hook preflights the daemon and fails fast rather than waiting out
  the full timeout.
- **The hook must resolve the same `TSB_HOME` as the daemon.** A mismatch means two
  different `.ledger.sqlite` files and every ask silently times out.
- **Hook `timeout` must exceed `awayMode.hookTimeoutSeconds`** or the harness cancels the
  hook mid-ask and the tool call proceeds ungated. The installer writes 330 against the
  default 300; raise both together.
- OpenCode loads plugins at startup, so plugin *code* changes need a restart — policy
  changes do not.
- **Not yet verified end-to-end.** `session.idle` on OpenCode is handled by throwing to
  signal "continue with this instruction", which is unproven — OpenCode documents
  `throw` for `tool.execute.before`, and whether an event handler can steer a session
  the same way has not been tested. Treat OpenCode's Stop equivalent as experimental.

Away mode makes whoever can DM the bot as the owner the permission authority for that
session. It reads `config.owner.slackUserId` only; the `agentSessions` allowlists
(`allowedUsers` D24, `allowedControllers` D31) deliberately do not grant it.

## Health checks

Run:

```bash
node cli/doctor.js --json
npm test
npm pack --dry-run --cache /private/tmp/team-slack-bridge-npm-cache
```

`doctor` reports presence booleans only; it must never print token values.

Every local state file holding a credential or PII (`.env`, `slack-config.json`,
`accounts.json`, `repos.json`) is written `0600` and self-heals that permission on every
write (D44) — if any of these were created before this protection existed, run once:

```bash
chmod 600 ~/.team-slack-bridge/.env ~/.team-slack-bridge/slack-config.json \
  ~/.team-slack-bridge/accounts.json ~/.team-slack-bridge/repos.json
```
