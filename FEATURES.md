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

Default: on when `SLACK_BOT_TOKEN` exists.

Use:

```bash
node cli/post.js --channel "#deploys" --text "build finished" --json
node cli/reply.js --channel "#deploys" --thread-ts "123.456" --text "done" --json
node cli/react.js --channel "#deploys" --ts "123.456" --emoji eyes --json
node cli/react.js --channel "#deploys" --ts "123.456" --emoji eyes --remove --json
```

Turn off: remove/withhold `SLACK_BOT_TOKEN`, or avoid using the commands.

### Post as user

Default: off.

Enable:

```bash
npm run get-user-token
```

Use:

```bash
node cli/post.js --channel "#deploys" --text "from me" --as-user --json
node cli/react.js --channel "#deploys" --ts "123.456" --emoji eyes --as-user --json
node cli/react.js --channel "#deploys" --ts "123.456" --emoji eyes --as-user --remove --json
```

Turn off: remove `SLACK_USER_TOKEN` from `.env`.

Remote Slackbot MCP never exposes this.

### DM as user / edit as user

Default: off (requires `SLACK_USER_TOKEN`, and currently blocked live by a missing scope — see
"Known gaps" below).

Use:

```bash
node cli/dm.js --user U0123ABC --text "from me" --as-user --json
node cli/update.js --channel C0123ABC --ts "169…" --text "updated" --as-user --json
```

MCP: `slack_dm_as_user`, `slack_update_message_as_user` — separate, explicitly named local-only tools
(never an ambiguous `asUser` boolean on `slack_dm`/`slack_update_message`, same reasoning as "Post as
user" above). `core/dm.js` caches the opened DM channel per **caller identity**
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
