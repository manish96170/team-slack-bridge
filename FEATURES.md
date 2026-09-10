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
node cli/agent-session.js create --slack-channel C0123 --slack-thread-ts "123.456" --kind review-request --json
```

Remote Slackbot MCP does not expose agent-session creation.

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

## Health checks

Run:

```bash
node cli/doctor.js --json
npm test
npm pack --dry-run --cache /private/tmp/team-slack-bridge-npm-cache
```

`doctor` reports presence booleans only; it must never print token values.
