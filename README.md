# team-slack-bridge

Post to Slack — as a bot, or explicitly as a specific authorized person — and DM,
from any script, agent, or CI job. Standalone: no dependency on any particular
orchestration system, AI agent framework, or dashboard.

Runtime: **Node >=26** (`package.json`'s `engines`). `.nvmrc` pins `26` for local dev on
this machine so the bridge stays on the current Node line rather than LTS.

## Four surfaces, one core

See `PLAN.md` for the full architecture and decisions log. In short: every capability is
a plain function in `core/` (tokens as parameters, no ambient state, no logging), and
each way of reaching it is a thin adapter that adds no behaviour of its own:

- **Direct** — `node cli/post.js …`, or `import { postToChannel } from './core/post.js'`.
  Root-level `post.js` / `get-user-token.js` / `verify-dm.js` still work unchanged.
- **MCP server (local)** — `node mcp/server.js` over stdio, full tool set. Point any
  MCP-capable client at it:
  ```jsonc
  { "mcpServers": { "team-slack-bridge": { "command": "node", "args": ["/abs/path/to/team-slack-bridge/mcp/server.js"] } } }
  ```
- **Skill** — `skill/SKILL.md`, shells out to the CLI. Invoke by name in Claude Code.
- **Dashboard agent** — the dashboard imports `core/` directly or calls the CLI.

Every outbound CLI/MCP command supports `--dry-run` (resolve and format the Slack call,
send nothing) and `--json` (structured `{ ok, ... }` output, non-zero exit on failure).
`node cli/doctor.js --json` reports install health without ever printing a token value.

Built for local/team use now: outbound posting, DMs, channel/thread reads, scheduling,
human approval/questions over DM, Socket Mode listening, listener daemon control,
progress-message updates, a locked-down Slackbot remote MCP surface, and ACP-driven
agent sessions where a Slack thread *is* a live session with Claude/Codex/OpenCode/
Gemini CLI (see "ACP agent sessions" below).

For the feature matrix and exact on/off switches, see `FEATURES.md`.

## Design principles

- **One shared Slack app for everyone who uses it — not one app per person.** The bot
  identity is shared infrastructure: every user of this tool can point at the same Bot
  Token, since the bot always acts as "the bot," never as a specific person. There's no
  conflict in sharing that token across people.
- **The user token (for posting *as* a specific person) is inherently per-person and
  can't be shared, by construction of Slack's own OAuth.** Slack's OAuth flow only ever
  produces a token for whoever personally authorizes it — each person who wants the
  "as-user" capability runs `npm run get-user-token` themselves, once, into their own
  local `.env`. Nobody's install ever contains anyone else's user token.
- **Naming a person is not authorization.** If you build identity-bound routing on top
  of this (e.g. "post as whoever this request is from"), verify that the request's own
  origin actually matches the named person — don't trust a caller-supplied name alone.
  This library doesn't enforce that for you (it's a single-token-per-install tool by
  design), but if you're wiring several people's tokens into one system, that check is
  yours to build.
- **Every install is local, holding its own credentials.** This is not a hosted
  service — no token, credential, or account-specific value ships in this repo (only
  `.env.example`, with empty values). `.env` is git-ignored.
- **Neither as-user posting nor DM-reading is a default, always-on capability.** Both
  require explicit setup (the OAuth user-token flow; a local password/authorization
  gate you add yourself if you build DM-reading on top of this) before they do
  anything at all.

## One-time setup

1. Create a Slack app from `config/slack-app-manifest.template.json`, or create a
   **Blank app** and configure the same scopes/events by hand. Under **OAuth &
   Permissions -> Scopes**, add these **Bot Token Scopes**:
   - `chat:write` — post messages as the bot
   - `im:write` — open/send DMs
   - `im:read`, `im:history` — only needed if you're also building DM-reading on top
     of this (e.g. a note-to-self pattern) — without these the bot can send a DM but
     not read what comes back. Skip if you only need outbound posting.
   - `channels:read`, `channels:history`, `groups:read`, `groups:history` — read
     public/private channels the bot is invited to (only needed if you'll query
     message history later — not used by anything in this repo yet)
   - `users:read` — resolve handles to user IDs

   If you also want the "post as a specific person" capability, add `chat:write` under
   **User Token Scopes** too, and set an OAuth redirect URL (see step 3).

   **Hard platform limit, not a scope issue**: none of the above ever lets the bot read
   a DM between two other people, or a DM the bot isn't a member of — Slack bots can
   only see conversations they're part of. The only way to read a person's own DM
   history is a user token authenticated as that person, which is a materially bigger
   privacy grant than anything else here — don't add it without deciding to.

   For Socket Mode, create an app-level token with `connections:write`.
   For future HTTP endpoints or slash commands, copy the Slack Signing Secret from
   **Basic Information -> App Credentials** into `SLACK_SIGNING_SECRET`.

2. Install the app to your workspace. Invite the bot to any channel you want it posting
   in (`/invite @your-app-name`). To DM the bot yourself, search its name in Slack or
   find it under **Apps** in the sidebar — no separate "invite to DM" step exists.
3. Run the setup wizard:
   ```bash
   node cli/setup.js init
   ```
   It writes `.env` and `slack-config.json`. Token prompts are local terminal input;
   do not run setup in a shared recording or paste tokens into chat.
4. If you want the "post as me" capability:
   ```
   npm run get-user-token
   ```
   Open the printed URL, approve, and the script writes `SLACK_USER_TOKEN` into `.env`
   itself — the token is never printed to the terminal.

## Usage

```bash
# default: post as the bot
node post.js --text "build finished" --channel "#deploys"

# explicit: post as your own authorized Slack identity
node post.js --text "reviewing this now" --channel "#deploys" --as-user

# DM someone (bot identity) — find their Slack member ID via their profile > "Copy member ID"
node post.js --text "can you take a look at this?" --dm U0123ABC

# setup and health
node cli/setup.js init
node cli/doctor.js --json

# run the Socket Mode listener as a daemon
node cli/daemon.js start --json
node cli/daemon.js status --json
node cli/daemon.js logs --lines 80
node cli/daemon.js stop --json

# progress message that gets edited in place
node cli/progress.js start --channel "#deploys" --label "Deploy" --detail "starting" --json
node cli/progress.js update --channel "#deploys" --ts "1699999999.000100" --label "Deploy" --status "running" --detail "tests passed" --json
node cli/progress.js finish --channel "#deploys" --ts "1699999999.000100" --label "Deploy" --detail "released" --json

# local output-mode control; the same can be exposed as Slack /outputmode
node cli/output-mode.js medium --json
```

## Runtime Notes

Slack Web API calls go through the official `@slack/web-api` `WebClient`, with the
existing core result shape preserved. Repeated DM sends cache the opened DM channel in
the local SQLite DB, so later sends to the same user avoid another `conversations.open`.
The listener uses Bolt Socket Mode; keep it running through `cli/daemon.js` for
approval buttons and event-driven free-text answers.

Dormant surfaces are config-gated and off by default:

```jsonc
{
  "outputMode": "medium",
  "http": { "enabled": false, "port": 8917, "verifySlackSignatures": true },
  "slashCommands": { "enabled": false, "outputModeCommand": "/outputmode" },
  "agentSessions": { "enabled": false, "autoCreateSession": false, "provider": "none" },
  "openacp": { "enabled": false, "adapterPackage": "@openacp/slack-adapter", "autoCreateSession": false },
  "slackbotMcp": {
    "enabled": false,
    "serverKey": "team-slack-bridge",
    "url": "",
    "authType": "slack_identity_auth",
    "authProviderKey": "",
    "exposeWriteTools": false,
    "allowedTools": [],
    "rateLimitPerMinute": 30
  },
  "localMcpDaemon": { "enabled": false, "port": 8918, "accountMode": "single" }
}
```

`SLACK_SIGNING_SECRET` is required when `http.enabled` is true and signature verification
remains enabled; it is always required when `slackbotMcp.enabled` is true, because `/mcp`
trusts Slack identity only after verifying Slack's request signature. `openacp.enabled`
only attempts to load the adapter package; it does not add OpenACP as a hard dependency or
change bridge behavior while disabled.
The HTTP Events API endpoint is `/webhook`, so a local listener runs at
`http://localhost:8917/webhook`. Slack itself cannot reach `localhost`; use this for
local tunnel testing or replace it with a public HTTPS URL in Slack Event Subscriptions.

Slackbot MCP Client support is also dormant by default. Keep `slackbotMcp.enabled:false`
until there is a public HTTPS MCP endpoint and a deliberately chosen safe tool set.
When enabling it, merge `config/slackbot-mcp.manifest.fragment.json` into the Slack app
manifest, set its `mcp_servers.<serverKey>.url` to the public `/mcp` endpoint, and add
the `mcp:connect` bot scope. Prefer `slack_identity_auth` for this repo so Slack user
and team identity are available to the MCP layer; leave `exposeWriteTools:false` unless
write tools have explicit authorization rules. The `/mcp` endpoint is implemented in
the optional HTTP listener, but it returns disabled by default; when enabled, it exposes
only `slack_doctor` unless `slackbotMcp.allowedTools` is set. Channel read/write tools
are additionally restricted by `remote.readableChannels` and `remote.postableChannels`;
DMs, human ask/approval, post-as-user, search, App Home publishing, scheduling, progress
mutation, and agent-session creation are absent from the remote registry by construction.

## ACP agent sessions — a Slack thread is a live session (PLAN D23–D27)

This is the reverse of the MCP surfaces above: instead of an agent calling a Slack
tool, a Slack thread becomes a live [Agent Client Protocol](https://agentclientprotocol.com)
(ACP v1) session with a real coding agent (Claude via `@agentclientprotocol/
claude-agent-acp`, Codex via `@agentclientprotocol/codex-acp`, OpenCode via
`opencode acp`, or Gemini CLI via `gemini --acp`). A human replies in the thread,
that becomes a prompt into the agent; the agent's streamed output, tool calls, and
permission requests render back into the same thread.

Not every message starts a session — only one of three explicit triggers does, and
only for `config.owner` or someone in the `agentSessions.allowedUsers` allow-list
(D24), checked inside `startAgentSession` itself regardless of which trigger reached
it. This is a materially bigger capability than posting messages: the agent can
read/write files and run real shell commands, via `fs/*`/`terminal/*` requests this
bridge answers on the agent's behalf, scoped to a named repo registry
(`core/repos.js`, D23) — a session can never reach a path outside the repo it was
started against.

```bash
node cli/repos.js add team-slack-bridge --path /absolute/path/to/team-slack-bridge
```

```json
"agentSessions": { "enabled": true, "allowedUsers": ["U0123ABC"], "mentionKeyword": "start session" }
```

Three ways to start one, all equivalent, all accepting an optional `--model name`:
1. **Slash command**: `/agent-session start --backend claude --repo team-slack-bridge --model opus fix the flaky test in core/db.js`
2. **@mention with the configured keyword** (`agentSessions.mentionKeyword`, default `"start session"`):
   `@team-slack-bridge start session --repo team-slack-bridge fix the flaky test`
3. **Message shortcut** — right-click any message → "Start agent session" → a modal
   asks for backend/repo/model/task; the session anchors to that message's thread
   (requires adding the `shortcuts` entry from
   `config/slack-app-manifest.template.json` to your installed app's manifest).

Model selection (D28) is protocol-driven, not a hardcoded per-backend table: ACP's
`session/new` response can advertise selectable model choices, and `--model` matches
against whichever ones the backend actually offers (by name or raw id) — an unknown
name fails the session start with the real list of what that backend supports, rather
than silently picking something else.

`--backend` defaults to `claude`; `--repo` defaults to whichever repo is registered as
default. Permission requests render as Approve/Deny buttons in the thread itself (not
a DM) using the same primitive as `core/ask.js`'s existing human-in-the-loop flow.
`/agent-session close` (run from within the session's thread) ends it explicitly —
or just reply `stop` or `exit` in the thread itself, no slash command needed. Both
paths persist `status:'closed'` even if the session was never resumed after a
listener restart, and both are gated by the same D24 allowlist as starting one —
someone else in the channel can't end a session they didn't start.
Local-profile-only (D26) — this never touches `mcp/tools.remote.js`/`mcp/http.js`.

**Surviving a listener restart (D29)**: a reply in a thread whose session was lost to a
restart (the in-memory state is gone, but `agent_sessions` still has the row) triggers
a resume attempt — `session/resume` first, `session/load` second, whichever the backend
actually advertised support for at connect time. If neither is supported, the reply
falls through to normal message handling exactly as if there had never been a session,
rather than erroring. This is lazy (only on the next reply, never an eager
resume-everything-at-startup pass) and gated by the same D24 allowlist as starting one.

## Connecting multiple AI coding harnesses / multiple Slack accounts (PLAN D21/D22)

Two independent things, both local-only — the remote/hosted `slackbotMcp` profile above
is untouched by either (D6 stands: no multi-tenancy there).

**Multiple harnesses sharing one server**, instead of each spawning its own stdio
`mcp/server.js` subprocess: enable `localMcpDaemon.enabled`, then

```bash
node cli/mcp-daemon.js start   # binds 127.0.0.1 only, full local tool set
```

and point every harness at `http://127.0.0.1:8918/mcp` (e.g. Claude Code:
`claude mcp add --transport http team-slack-bridge http://127.0.0.1:8918/mcp`) instead
of stdio-spawning the server. `cli/mcp-daemon.js stop|restart|status|logs` mirror
`cli/daemon.js`'s controls for the Socket Mode listener.

**Multiple Slack accounts/workspaces**, either:
- register N stdio servers, one per account, each with a different `TSB_HOME`:
  `claude mcp add team-slack-bridge-work -s user -- env TSB_HOME=~/.team-slack-bridge-work node mcp/server.js`
  (works today, no config needed), or
- one shared daemon in multi-account mode:
  ```bash
  node cli/accounts.js add work --home ~/.team-slack-bridge-work
  TSB_HOME=~/.team-slack-bridge-work node cli/setup.js init   # that account's own .env/slack-config.json
  ```
  then set `localMcpDaemon.accountMode: "multi"` and pass `"account": "work"` in a
  tool call's `arguments` to address that account; omit it for the default account.
  `node cli/accounts.js list|remove|set-default` manage the registry
  (`~/.team-slack-bridge/accounts.json`). This registry and daemon are fully opt-in —
  absent `accounts.json`, everything behaves exactly as a single-account install always
  has.

**Two MCP-server options, if a typed-tool front door is wanted instead of/alongside the
CLI — pick deliberately, don't default to whichever is more capable:**
- **`@modelcontextprotocol/server-slack`** (reference implementation) — exposes Slack
  as agent-callable tools. Provides no identity-bound authorization
  (`requestedPersonName == callerIdentity`) or bot-default/as-user-explicit rule — a
  consuming system still has to layer that on itself.
- **`slack-mcp-server`** (community, more capable — search, threads, reactions, unread
  tracking; posting disabled by default, matching this repo's own bot-default caution)
  — but it also supports **browser-session "stealth mode" tokens (`xoxc`/`xoxd`)**: full
  account access via browser cookie, no bot app install required. That's the opposite
  of everything this repo is designed around (scoped bot tokens, real OAuth for user
  tokens, identity-bound authorization). **If this server is ever used, OAuth-token
  mode only — never stealth mode.** The extra capability (message/thread search) is
  worth having; the bypass-every-guardrail auth mode is not.

**Not Slack-specific, noted for a different reason — `novu`.** A general multi-channel
notification platform (email/SMS/push/13 chat providers including Slack), not a
Slack library. Conceptually a good fit for "integrations-as-data" — one provider
abstraction instead of N bespoke outbound agents once email/Drive/etc. are real. But it
requires running its own hosted/self-hosted backend (Docker) — no lightweight
backend-free mode exists. Premature to adopt for "post to one Slack channel" — revisit
only if/when Slack + email + something else *all* need unified outbound at once.

## Scope note

Default post-as identity is always **the bot** — posting "as a specific person"
requires the explicit `--as-user` flag, never inferred or defaulted. If you build
anything routing requests to different people's tokens, keep that rule: explicit
beats inferred, always.

## License

MIT
