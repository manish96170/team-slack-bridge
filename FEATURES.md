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
| `SLACK_USER_TOKEN` | local `--as-user` and local search only | optional |
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
```

Turn off: remove `SLACK_USER_TOKEN` from `.env`.

Remote Slackbot MCP never exposes this.

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
9 tools, never touches the remote/hosted profile (D6 unchanged).

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

### Away mode — Claude Code hooks (PLAN D34–D38)

Default: off (no `.away` flag file, hooks exit immediately).

Routes a *local* Claude Code session's permission prompts to Slack, so the laptop can be
left alone. Unlike ACP agent sessions, this works on sessions the bridge never spawned —
see D34 for why mid-way ACP adoption is impossible.

Toggle:

```bash
node cli/away.js on [--timeout-seconds 3600] [--max-continuations 3] [--json]
node cli/away.js status --json
node cli/away.js off
```

Wire the hooks once, in the target project's `.claude/settings.json` (a global install
exposes the `tsb-hook` binary):

```json
{ "hooks": {
  "PreToolUse":   [{ "matcher": "Bash|Write|Edit|NotebookEdit",
                     "hooks": [{ "type": "command", "command": "tsb-hook preToolUse", "timeout": 330 }] }],
  "Stop":         [{ "hooks": [{ "type": "command", "command": "tsb-hook stop", "timeout": 330 }] }],
  "PreCompact":   [{ "matcher": "auto",
                     "hooks": [{ "type": "command", "command": "tsb-hook preCompact", "timeout": 30 }] }],
  "Notification": [{ "matcher": "idle_prompt|agent_needs_input|agent_completed",
                     "hooks": [{ "type": "command", "command": "tsb-hook notification", "timeout": 15 }] }]
} }
```

Per event:

| Event | Behaviour |
| --- | --- |
| `PreToolUse` | Approve/Deny buttons in a DM; tool name, cwd and subagent attribution (`agent_type`/`agent_id`) in the question |
| `Stop` | Free-text "what should it do?" — reply `done`/`stop`/empty lets it stop, any other text continues the session with your reply as steering context |
| `PreCompact` | Informational DM on `trigger: auto` only. **Cannot be blocked** (D38) |
| `Notification` | Fire-and-forget DM, never blocks |

Hook `timeout` must exceed the ask timeout (default 300s) or the harness cancels the hook
mid-ask and the tool call proceeds ungated.

Everything fails **open** (D35): a timeout, a stopped listener, or any internal error
produces no output and exit 0, so the tool call falls through to the normal local prompt.
Nothing is ever silently approved. Because approval buttons require the Socket Mode
listener, the hook preflights the daemon and fails open immediately rather than waiting
out the full timeout.

`PreToolUse` approvals need the listener running and the hook must resolve the same
`TSB_HOME` as the daemon — a mismatch means two different `.ledger.sqlite` files and
every ask silently times out.

Away mode makes whoever can DM the bot as the owner the permission authority for that
session. It reads `config.owner.slackUserId` only; the `agentSessions` allowlists
(`allowedUsers`, `allowedControllers`) deliberately do not grant it.

## Health checks

Run:

```bash
node cli/doctor.js --json
npm test
npm pack --dry-run --cache /private/tmp/team-slack-bridge-npm-cache
```

`doctor` reports presence booleans only; it must never print token values.
