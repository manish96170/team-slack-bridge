# team-slack-bridge

Post to Slack — as a bot, or explicitly as a specific authorized person — and DM,
from any script, agent, or CI job. Standalone: no dependency on any particular
orchestration system, AI agent framework, or dashboard.

Runtime: **Node >=26** (`package.json`'s `engines`). `.nvmrc` pins `26` for local dev on
this machine so the bridge stays on the current Node line rather than LTS.

**Install**: `npm install team-slack-bridge` (or `-g` for the `team-slack-bridge` and
`tsb-hook` binaries) for normal use. `npm run build:sea` (standalone-binary packaging) and
`npm test` only work from a git clone with `devDependencies` installed — they bundle
this repo's own source/tests, which aren't part of the published package.

## Four surfaces, one core

```
┌───────────────┐   ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│      CLI      │   │  MCP server   │   │     Skill     │   │   Dashboard   │
│ node cli/*.js │   │(stdio / HTTP) │   │   SKILL.md    │   │     agent     │
└───────────────┘   └───────────────┘   └───────────────┘   └───────────────┘
        │                   │                   │                   │
        ┴───────────────────┴─────────┬─────────┴───────────────────┴
                                      │
                  ┌───────────────────┬──────────────────┐
                  │              core/*.js               │
                  │  no ambient state, tokens as params  │
                  └──────────────────────────────────────┘
                                      │
               ┌──────────────────────┬─────────────────────┐
               │                   Slack                    │
               │           Web API + Socket Mode            │
               │(post, DM, events, approvals, ACP sessions) │
               └────────────────────────────────────────────┘
```

See `PLAN.md` for the full architecture and decisions log, `TODO.md` for the current
done/pending status, and `ROADMAP.md` for longer-horizon ideas that aren't decided or
scheduled yet. In short: every capability is
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
Gemini CLI (see "ACP agent sessions" below). That remote MCP surface now also
supports an opt-in multi-tenant mode — one shared deployment serving several Slack
workspaces/companies, each isolated by `team_id`, provisioned with `cli/tenants.js`
— alongside today's single-workspace default; see "Dormant surfaces" below.

For the feature matrix and exact on/off switches, see `FEATURES.md`.

## Capabilities at a glance

| Capability | Default | Change it with | Decision |
|---|---|---|---|
| `slack_post` / `slack_reply` / `slack_dm` (MCP) | **As you** — a real Slack message, visible to you with native edit/delete | `viaBot:true` | D47 |
| Sending as the bot without an identified sender | **Refused** | `anonymousMessage:true` | D48 |
| Attribution footer on a bot-sent message | **On** — `<@you> · memberId:U...` | `anonymousMessage:true` → "sender withheld" | D48 |
| Private tracking DM to the sender of a bot send | **On** — even in anonymous mode | `botSendTracking.enabled:false` | D48 |
| `anonymousMessage` without a per-call argument | Falls back to config | `botSend.anonymousMessageDefault` | D49 |
| `slack_lookup_user` — live directory lookup | Bot token | `tokenSource:"user"` | D50/D51 |
| Email in a `slack_lookup_user` result | **Hidden** | `includeEmail:true` | D50 |
| `slack_resolve_user` display-name matching | **On** — fallback after name/handle/ID | configure `displayName` per user | D55 |
| Remote/hosted `slackbotMcp` multi-tenancy | **Off** (`"single"`, one deployment = one workspace) | `slackbotMcp.tenancy.mode: "multi"` + `cli/tenants.js add` | D53/D54 |
| CLI post-as identity (`cli/post.js` etc.) | **The bot**, unchanged | `--as-user` | pre-existing, see "Scope note" |

```
slack_post / slack_reply / slack_dm  (MCP tools)
            │
            ▼
     viaBot:true? ──no──► SLACK_USER_TOKEN ──► it's really your message:
            │                                   visible to you, native Slack edit/delete
           yes
            │
            ▼
  sender identified, OR anonymousMessage           refused:
  resolves true (per-call or config default)? ──no──► not-authorized-to-send-as-bot-
            │                                          pass-anonymousMessage-true-...
           yes
            │
            ▼
     SLACK_BOT_TOKEN ──► public text gets a footer:
                          "sent via bot by <@you> · memberId:U..."
                          (or "sender withheld" if anonymous)
            │
            ▼
     sender identified? ──yes──► private DM to the sender:
            │                     "You have sent ... via Bot"  (parent)
            no                    + the real text               (thread reply)
            │
            ▼
     (no tracking copy — nobody to send it to)
```

Every one of these is additive on top of the pre-existing `_as_user` tools
(`slack_post_as_user`, `slack_dm_as_user`, `slack_update_message_as_user`,
`slack_delete_message_as_user`) and `slack_resolve_user` (config-file-only, untouched
by any of this) — nothing above changes what those already did.

## Two ways to run an agent from Slack

These solve different problems and are easy to confuse, so it is worth being explicit
about which one you want:

```
  ACP agent sessions                        Away mode
  "start the work from Slack"               "I already started; let me leave"

  ┌──────────┐                              ┌──────────────────────────┐
  │  Slack   │  start session               │   your terminal          │
  │  thread  │ ───────────────►             │   claude / opencode …    │
  └────┬─────┘                              └───────────┬──────────────┘
       │                                                │ hook / plugin
       ▼                                                ▼
  ┌──────────────────┐                      ┌──────────────────────────┐
  │ bridge SPAWNS    │                      │ bridge is ASKED by the   │
  │ the agent (stdio)│                      │ harness, per tool call   │
  └────────┬─────────┘                      └───────────┬──────────────┘
           │                                            │
           └──────────────► Slack DM: Approve / Deny ◄───┘

  thread == the session                     your session stays yours
  no per-harness config                     one-time install per harness
```

A session the bridge did **not** spawn can never be adopted into ACP mid-way — ACP
installs its permission callback at spawn, when it owns the agent's stdio. That is exactly
the gap away mode fills (PLAN D34).

## Design principles

- **One shared Slack app for everyone who uses it — not one app per person.** The bot
  identity is shared infrastructure: every user of this tool can point at the same Bot
  Token, since the bot always acts as "the bot," never as a specific person. There's no
  conflict in sharing that token across people.
- **Because the bot token is shared, `slack_post`/`slack_reply`/`slack_dm` default to
  sending as the local user, not as the bot (D47-D49)** — see "Capabilities at a glance"
  above for exactly how the authorization gate, attribution footer, and tracking DM
  work together. Full reasoning: `FEATURES.md`'s "Post as user" section and `PLAN.md`
  §18-§20.
- **`slack_lookup_user` resolves anyone in the workspace live, via an explicit
  `tokenSource:"bot"|"user"` (default `"bot"`) — never a silent fallback between the
  two (D50-D51).** Separate from `slack_resolve_user`, which stays config-file-only and
  untouched. Ambiguous handle/name matches are refused with every match listed, never
  guessed; email is hidden from the result unless `includeEmail:true`; and it's
  local-only regardless of which token is used, same posture as
  `slack_list_channels`/`slack_search`, since an unrestricted directory search is a
  workspace-enumeration primitive. See `FEATURES.md`'s "Live directory lookup" section
  and `PLAN.md` §21/D51.
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

```
┌──────────────────────────┐     ┌──────────────────────────┐     ┌──────────────────────────┐     ┌──────────────────────────┐
│    npm install -g        │  ▶  │  node cli/setup.js init  │  ▶  │node cli/daemon.js start  │  ▶  │  talk to it in Slack     │
│  team-slack-bridge       │     │  (interactive wizard)    │     │ (Socket Mode listener)   │     │(@mention / DM / slash)   │
└──────────────────────────┘     └──────────────────────────┘     └──────────────────────────┘     └──────────────────────────┘
```

1. Create a Slack app from `config/slack-app-manifest.template.json`, or create a
   **Blank app** and configure the same scopes/events by hand. Under **OAuth &
   Permissions -> Scopes**, add these **Bot Token Scopes**:
   - `chat:write` — post messages as the bot
   - `im:write` — open/send DMs
   - `files:write` — upload a screenshot/video as the bot (`cli/upload.js`/`slack_upload_file`)
   - `im:read`, `im:history` — only needed if you're also building DM-reading on top
     of this (e.g. a note-to-self pattern) — without these the bot can send a DM but
     not read what comes back. Skip if you only need outbound posting.
   - `channels:read`, `channels:history`, `groups:read`, `groups:history` — read
     public/private channels the bot is invited to (only needed if you'll query
     message history later — not used by anything in this repo yet)
   - `users:read` — resolve handles to user IDs

   If you also want the "post as a specific person" capability, add these **User Token
   Scopes**, and set an OAuth redirect URL (see step 3):
   - `chat:write` — post/edit messages as the authorized user
   - `search:read` — `cli/search.js`/`slack_search` (user-token-only; Slack has no bot
     equivalent)
   - `im:write` — open DMs as the user (`cli/dm.js --as-user`/`slack_dm_as_user`);
     `conversations.open` fails `missing_scope` without it
   - `channels:read`, `groups:read`, `im:read`, `mpim:read` — `cli/channels.js`/
     `slack_list_channels`, "which conversations is this person actually in" (uses
     `users.conversations`, scoped to their own membership — never the whole
     workspace)
   - `files:write` — upload a screenshot/video as the user (`cli/upload.js --as-user`/
     `slack_upload_file_as_user`), e.g. evidence attached to an MR announcement
   - `reactions:write` — add/remove a reaction as the user (`cli/react.js --as-user`/
     `slack_react_as_user`/`slack_unreact_as_user`)

   `get-user-token.js`/`npm run get-user-token` requests all of the above in one go.
   **Any scope change here requires reinstalling the app and re-running
   `npm run get-user-token`** — an existing `SLACK_USER_TOKEN` keeps whatever scopes it
   was minted with.

   ```
   ┌─────────────────────────┐          ┌─────────────────────────┐
   │     SLACK_BOT_TOKEN     │          │     SLACK_USER_TOKEN    │
   │  "the bot" — one app,   │          │  "you" — per person,    │
   │   shared by everyone    │          │   never shared          │
   ├─────────────────────────┤          ├─────────────────────────┤
   │ post / reply / react    │          │ post-as-me / dm-as-me   │
   │ read channels it's a    │          │ search (your own query) │
   │  member of              │          │                         │
   │ conversations.list      │          │ users.conversations     │
   │  → every channel the    │          │  → only the channels    │
   │    BOT can see          │          │    YOU are a member of  │
   └─────────────────────────┘          └─────────────────────────┘
   ```

   `cli/channels.js` / `slack_list_channels` deliberately uses `users.conversations`,
   never `conversations.list` — the former can only ever return what the authorized
   person could already see in their own Slack sidebar, never the whole workspace.

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
3. Run the setup wizard — every prompt has a default/skip and a "leave off if unsure"
   hint, so it's safe to just hit enter through anything you're not ready to answer yet:
   ```bash
   node cli/setup.js init     # from a git clone
   tsb-setup init             # from a global npm install
   ```
   ```text
   $ node cli/setup.js init
   Slack bot token (xoxb-, paste locally; input is echoed): xoxb-...
   Slack app token for Socket Mode (xapp-, optional but needed for listener): xapp-...
   Slack signing secret (optional, needed for HTTP/slash endpoints):
   Owner Slack user ID (U...): U0123ABC
   Watched channel ID or name (#code-review): #code-review
   Channel purpose (review-request|team-request): review-request
   Output mode (low|medium|high, default medium): medium
   Enable the HTTP surface? (y/N — recommended: N if unsure) — an alternative to Socket
   Mode for slash commands/interactivity — opens a local port. Socket Mode (the listener)
   already covers this without one. Leave off unless you specifically need an HTTP
   endpoint: n
   Enable Slack slash commands (/outputmode)? (y/N — recommended: N if unsure) — requires
   Interactivity enabled in the Slack app manifest first — leave off if you have not
   reinstalled the app with that setting yet: n
   Enable agent-session tracking? (y/N — recommended: N if unsure) — links Slack threads
   to Claude Code/OpenCode sessions — leave off until you have picked a provider: y
   Enable the OpenACP (Agent Client Protocol) adapter? (y/N — recommended: N if unsure): n
   Enable Slack's own remote MCP connector passthrough? (y/N — recommended: N if unsure): n
   Initialized ~/.team-slack-bridge/slack-config.json and ~/.team-slack-bridge/.env
   (token values not printed).
   Enabled: Enable agent-session tracking
   ```
   It writes `.env` and `slack-config.json`. Token prompts are local terminal input;
   do not run setup in a shared recording or paste tokens into chat. Every value can
   also be passed as a flag to skip its prompt non-interactively (e.g.
   `--owner U0123ABC`), which is what CI or a scripted install would use instead.

   The wizard has other subcommands too, for changing things later without re-running
   `init`'s full token/owner/channel flow:
   ```bash
   node cli/setup.js add-user                                            # interactive: name, handle, Slack user ID, Jira handle
   node cli/setup.js set-owner --user U0123ABC
   node cli/setup.js watch-channel --channel '#code-review' --purpose review-request
   node cli/setup.js dm-allow --user U0456DEF
   node cli/setup.js features                       # revisit the default-off toggles later, same prompts as init
   node cli/setup.js features --enable-http true     # skip a specific prompt non-interactively
   ```
4. If you want the "post as me" capability:
   ```
   npm run get-user-token        # from a git clone
   tsb-get-user-token            # from a global npm install
   ```
   Open the printed URL, approve, and the script writes `SLACK_USER_TOKEN` into `.env`
   itself — the token is never printed to the terminal.

   This (and the multi-workspace flow below) runs over **local HTTPS**, not HTTP (PLAN
   D56): a self-signed cert for `localhost`/`127.0.0.1` is generated on first use
   (`core/local-tls.js`, via your system's own `openssl` — no new dependency, and
   Let's Encrypt genuinely cannot help here since it only certifies domains it can
   verify over the public internet, which `localhost` isn't). Your browser will show a
   one-time "not private" warning the first time it hits `https://localhost:8917/callback`
   — expected for a self-signed cert, safe to proceed past. To skip that warning
   entirely, install [mkcert](https://mkcert.dev) (free) and set
   `SLACK_LOCAL_TLS_CERT`/`SLACK_LOCAL_TLS_KEY` in `.env` to its output instead of
   letting this repo generate its own. To generate (or just locate) that cert on its
   own, without running a full OAuth flow:
   ```
   node cli/tls.js generate       # from a git clone
   tsb-tls generate               # from a global npm install
   ```

## Installing into another workspace (multi-tenancy, PLAN D54/D56)

If this app's Slack install already has [Public Distribution](https://api.slack.com/apps)
activated (Manage Distribution → Public Distribution), you can install the *same* app
into a different workspace — even one in a completely separate Slack org — without
creating a second app or redoing scopes:

```bash
# from a git clone
node cli/tenants.js add <TEAM_ID>                              # prints a home dir
TSB_HOME=<printed home> node get-workspace-token.js            # bot-token install flow

# from a global npm install
tsb-tenants add <TEAM_ID>                                      # prints a home dir
TSB_HOME=<printed home> tsb-get-workspace-token                # bot-token install flow
```

Open the printed authorize URL **while logged into the target workspace** and approve
— `get-workspace-token.js` captures the resulting bot token straight into that tenant's
own `.env` (same local-HTTPS pattern as `get-user-token.js` above), ready for
`core/tenancy.js`'s `tenancyMode:"multi"` to resolve by `team_id`. See `cli/tenants.js`'s
own header and `ROADMAP.md`'s "Multi-tenancy as a configurable deployment mode" for the
full picture — this covers hand-provisioned installs; a self-serve "Add to Slack" flow
remains deliberately deferred until an actual company asks for it.

## Usage

Every command below accepts `--json` (structured `{ ok, ... }` output, non-zero exit
on failure) and, for anything that actually sends to Slack, `--dry-run` (resolve and
format the call, send nothing). All of them are plain `node cli/<name>.js` invocations
from a git clone; `npm install -g` installs six direct commands —
`team-slack-bridge` (alias for `post.js`), `tsb-hook`, `tsb-tls`, `tsb-tenants`,
`tsb-get-user-token`, and `tsb-get-workspace-token` (`package.json`'s `bin`) — but is
not a dispatcher for every subcommand below. For anything else on a global install, run
`node $(npm root -g)/team-slack-bridge/cli/<name>.js` (or just work from a git clone
instead, which is what most of this README assumes).

**Post, reply, edit, react, delete:**
```bash
node post.js --channel '#x' --text 'hi' [--thread-ts …] [--as-user] [--idempotency-key …] [--dry-run] [--json]
node cli/reply.js --channel '#x' --thread-ts '169…' --text 'hi' [--idempotency-key …] [--dry-run] [--json]
node cli/update.js --channel '#x' --ts '169…' --text 'new text' [--as-user] [--dry-run] [--json]  # --as-user required if the original was posted as-user
node cli/delete.js --channel '#x' --ts '169…' [--dry-run] [--json]
node cli/react.js --channel '#x' --ts '169…' --emoji eyes [--remove] [--as-user] [--dry-run] [--json]  # --as-user adds/removes only the authorized user's reaction
```

**DM someone** (find their Slack member ID via their profile → "Copy member ID"):
```bash
node cli/dm.js --user U0123ABC --text 'hi' [--as-user] [--dry-run] [--json]
```

Bot-sent and as-you-sent DMs are never conflated — each identity opens and caches its
*own* conversation, keyed by a fingerprint of the actual token in use (never the token
value itself), so a token rotation busts only that identity's cache entry:

```
dm({ asUser: false })  ──►  SLACK_BOT_TOKEN   ──►  conversations.open  ──►  its own DM
dm({ asUser: true  })  ──►  SLACK_USER_TOKEN  ──►  conversations.open  ──►  its own DM

           same recipient, two separate conversations — never shared, never crossed
```

**Read channels/threads/search** (search requires a user token — Slack's own
per-person construction):
```bash
node cli/query.js --channel '#x' [--since-minutes 60] [--limit 20] [--json]
node cli/thread.js --channel '#x' --thread-ts '169…' [--json]
node cli/search.js --query 'from:@bob deploy' [--json]
node cli/resolve-user.js --handle @jane [--json]  # configured-only, config-file lookup — never a network call
node cli/lookup-user.js --query U055NFSGF88 [--mode auto|id|email|handle|name] [--as-user] [--include-email] [--json]  # live Slack-directory lookup, for anyone NOT in slack-config.json (D50/D51)
node cli/channels.js [--types 'public_channel,private_channel'] [--limit 100] [--cursor …] [--json]  # requires a user token — which channels the authorized user is actually in, not the whole workspace
```

**Scheduling** (`--at` accepts ISO-8601 or raw Unix seconds):
```bash
node cli/schedule.js --channel '#x' --text 'hi' --at '2026-09-10T09:00:00-07:00' [--thread-ts …] [--as-user] [--dry-run] [--json]
node cli/scheduled.js [--channel '#x'] [--limit 20] [--as-user] [--json]
node cli/unschedule.js --channel '#x' --scheduled-id Q1234567890 [--as-user] [--dry-run] [--json]
```

**Human-in-the-loop** (`approval` requires the Socket Mode listener running — a
button click is never visible to a direct poll):
```bash
node cli/ask.js --user U0123ABC --question 'Deploy to prod?' --kind approval [--options 'Approve,Deny'] [--timeout 300] [--capture-mode listener|poll] [--json]
```

**Away mode** — route a session *you* started to Slack, so you can leave the laptop
(PLAN D34–D40; see "Away mode" below and `FEATURES.md` for the full matrix):
```bash
node cli/hooks-install.js claude    # or: opencode — writes that harness's config, once
node cli/away.js on                 # flip on before you walk away
node cli/away.js status --json
node cli/away.js off
```

**Setup and health:**
```bash
node cli/setup.js init                 # interactive: writes .env and slack-config.json
npm run get-user-token                 # one-time OAuth flow for the --as-user capability
node cli/doctor.js --json              # install health, never prints a token value
node cli/home.js --user U0123ABC [--dry-run] [--json]   # manually (re)publish the App Home tab
```

**Progress messages** (one message, edited in place across `start`/`update`/`finish`):
```bash
node cli/progress.js start --channel "#deploys" --label "Deploy" --detail "starting" [--thread-ts ts] --json
node cli/progress.js update --channel "#deploys" --ts "1699999999.000100" --label "Deploy" --status "running" --detail "tests passed" --json
node cli/progress.js finish --channel "#deploys" --ts "1699999999.000100" --label "Deploy" [--ok false] --detail "released" --json
```

**Output mode** (local control; can also be exposed as Slack `/outputmode`):
```bash
node cli/output-mode.js [low|medium|high] --json
```

**Socket Mode listener daemon** — must be running for approval buttons, event-driven
free-text answers, and every ACP agent-session trigger below:
```bash
node cli/daemon.js start --json      # idempotent — safe as a cron entry for auto-restart-on-crash
node cli/daemon.js status --json
node cli/daemon.js logs --lines 80
node cli/daemon.js restart --json
node cli/daemon.js stop --json
```

**Named repo registry** (D23 — an ACP session's fs/terminal access is scoped to one
of these, never a raw path typed into Slack):
```bash
node cli/repos.js add <name> --path /absolute/path
node cli/repos.js list
node cli/repos.js remove <name>
node cli/repos.js set-default <name>
```

**Agent-session records** (local bookkeeping/listing — see "ACP agent sessions"
below for the actual Slack-facing start/close/reopen commands):
```bash
node cli/agent-session.js create [--channel C123] [--thread-ts ts] [--kind review-request] [--json]
node cli/agent-session.js list [--status active|closed|created] [--kind acp-session] [--limit 20] [--json]
```

**Local HTTP endpoint** (optional, off unless `http.enabled` in `slack-config.json`):
```bash
node cli/http.js --json
```

See "Connecting multiple AI coding harnesses / multiple Slack accounts" below for
`cli/accounts.js` and `cli/mcp-daemon.js`.

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
    "rateLimitPerMinute": 30,
    "tenancy": { "mode": "single" }
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

**Multi-tenancy (`slackbotMcp.tenancy.mode`, PLAN D53/D54).** `"single"` (the
default) is byte-identical to every description above: one deployment, one Slack
workspace. `"multi"` really works now, not just as a config value: a registered
Slack `team_id` resolves to that tenant's own `env`/`config`/`dbPath`, isolated
from every other tenant on this same deployment — provision one with `node
cli/tenants.js add <teamId> [--home <path>]`, then `TSB_HOME=<home> node
cli/setup.js init` against the printed home dir, same two-step pattern as the
local-only account registry (`cli/accounts.js`, D21). An unregistered `team_id`,
or a `multi`-flagged request with no Slack-signed `team_id` at all, refuses
clearly rather than falling back to any tenant's data — there is deliberately no
"default" tenant. Still outstanding before this is production-ready for more
than one real company: a live dogfood run against a real public `/mcp` endpoint
(ROADMAP.md's step 3) — today this is unit-tested, not yet exercised against two
real Slack workspaces.

## ACP agent sessions — a Slack thread is a live session (PLAN D23–D27)

This is the reverse of the MCP surfaces above: instead of an agent calling a Slack
tool, a Slack thread becomes a live [Agent Client Protocol](https://agentclientprotocol.com)
(ACP v1) session with a real coding agent (Claude via `@agentclientprotocol/
claude-agent-acp`, Codex via `@agentclientprotocol/codex-acp`, OpenCode via
`opencode acp`, or Gemini CLI via `gemini --acp`). A human replies in the thread,
that becomes a prompt into the agent; the agent's streamed output, tool calls, and
permission requests render back into the same thread.

**Quick reference** — everything below is covered in detail further down:

| Action | How |
| --- | --- |
| Start a session | `/agent-session start [--backend name] [--repo name] [--model name] <task>`, an `@mention`/DM starting with `agentSessions.mentionKeyword` (or any of `mentionKeywords`), or the "Start agent session" message shortcut |
| Reply / continue | Just reply in the session's thread — no command needed |
| End a session | Reply `stop` or `exit` **exactly** in its thread, or `/agent-session close <id>` |
| End every session in this channel | `/agent-session close all` |
| Bring a closed session back | `/agent-session reopen <id>` (only works for a thread's *latest* session) |
| List sessions / find an id | `node cli/agent-session.js list` (or read it off any close confirmation) |
| Trim context and keep going | Reply `compact` once a session has warned it's near its limit |
| Continue with a fresh session, seeded from the handoff | Reply `here` (or `new session`) after the context-limit warning |
| Seed a new session from an earlier point in this one | Reply `rewind`, then answer how far back and how much detail |

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│     ① START     │     │   ② CONVERSE    │     │ ③ CONTEXT LIMIT │     │      ④ END      │
│ start session,  │  ▶  │  reply in the   │  ▶  │   ~80% full:    │  ▶  │  stop / exit /  │
│ @mention, or DM │     │thread — one log │     │handoff + choice │     │   close <id>    │
└─────────────────┘     └─────────────────┘     └─────────────────┘     └─────────────────┘
```

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
"agentSessions": { "enabled": true, "allowedUsers": ["U0123ABC"], "mentionKeyword": "start session", "allowedControllers": [] }
```

Four ways to start one, all equivalent, all accepting an optional `--model name`:
1. **Slash command**: `/agent-session start --backend claude --repo team-slack-bridge --model opus fix the flaky test in core/db.js`
   (works in a channel or in a DM to the app — Slack slash commands aren't channel-restricted).
2. **@mention with the configured keyword** (`agentSessions.mentionKeyword`, default `"start session"`):
   `@team-slack-bridge start session --repo team-slack-bridge fix the flaky test`.
   Multiple aliases can trigger the same way via `agentSessions.mentionKeywords`
   (a list, checked longest-first so a longer alias is never shadowed by a shorter
   one that happens to prefix it) — e.g. `["start session", "@etd start session"]`
   lets people type either phrase, in a channel @mention or a DM alike.
3. **A DM directly to the app** with the same keyword (D33) — no channel or @mention needed
   at all, since there's nothing to @-mention when you're already talking to the app
   directly: just DM `start session --repo team-slack-bridge fix the flaky test`, and the
   session lives entirely in that DM thread. This only fires for a DM from a real human by
   default — a message.im event from another Slack app/bot carries no `user` id at all (it
   has `bot_id`/`app_id` instead), so it's dropped before ever reaching the allowlist check.
   To let a specific trusted app DM-trigger sessions on a named human's behalf, add its
   `bot_id` or `app_id` to `agentSessions.trustedApps`:
   ```json
   "agentSessions": { "trustedApps": { "A0123ENGDASH": "U0123ABC" } }
   ```
   The DM is then treated exactly as if `U0123ABC` sent it — same `allowedUsers`/
   `repoAccess` checks apply, so this is scoping *who the app acts as*, not a bypass.
4. **Message shortcut** — right-click any message → "Start agent session" → a modal
   asks for backend/repo/model/task; the session anchors to that message's thread
   (requires adding the `shortcuts` entry from
   `config/slack-app-manifest.template.json` to your installed app's manifest).

Model selection (D28) is protocol-driven, not a hardcoded per-backend table: ACP's
`session/new` response can advertise selectable model choices, and `--model` matches
against whichever ones the backend actually offers (by name or raw id) — an unknown
name fails the session start with the real list of what that backend supports, rather
than silently picking something else.

**One message per session, not one per reply.** Starting a session posts two
messages: a short static one (the thread's root, if this is a new thread — that one
is never touched again, so it doesn't grow into a wall of text sitting in the
channel's main view) and a second message, always inside the thread, that every
turn — the initial task and every reply after it — appends onto, separated and
prefixed with the prompt that triggered it, rather than scattering the conversation
across many separate Slack messages (tried that first; it just made the thread
noisy) or growing the channel-visible root (the very first behavior — worse, since
that's not even inside the thread). This is Slack's `chat.update`, which hard-errors
past 4,000 characters — there's no way to keep an unlimited transcript live in one
continuously-edited message, so only the most recent ~3,500 characters stay visible
in it; it's a rolling window onto the conversation, not a guaranteed full history.

`--backend` defaults to `claude`; `--repo` defaults to whichever repo is registered as
default. Permission requests render as Approve/Deny buttons in the thread itself (not
a DM) using the same primitive as `core/ask.js`'s existing human-in-the-loop flow.
Reply `stop` or `exit` **exactly** (nothing else — a full sentence like "stop this
session and exit" doesn't match and gets forwarded to the agent as an ordinary
prompt instead, which will happily reply conversationally without the bridge
having closed anything) directly in a session's thread to end it, no slash command
needed. `/agent-session close <id>` does the same thing by id instead — a slash
command's payload never carries `thread_ts`, regardless of where it's typed
(confirmed against Slack's own docs: developer slash commands can't be invoked
inside threads at all), so `close` can't identify "the session in the thread I'm
replying from" the way a plain message reply can. Find the id in a close/"Session
closed" confirmation, a thread's own messages, or `cli/agent-session.js list`.
`/agent-session close all` closes every still-open session in the current channel
in one shot, skipping (and reporting) any you don't have D31 close rights over.
All three paths persist `status:'closed'` even if the session was never resumed
after a listener restart.

**Reopening one you closed on purpose**: a closed session can never be picked back
up by just replying in its thread — `tryResumeSession` refuses on sight once
`status:'closed'`, by design (that check is what makes closing permanent instead of
just another kind of restart-recovery gap). Every close confirmation (`stop`/`exit`
in the thread, or `/agent-session close`) includes the session's id right in the
message, so you don't need to separately run `cli/agent-session.js list` to find
it later. To deliberately bring one back, run `/agent-session reopen <id>` (gated
by the same D31 close-rights check as closing it) — this only flips the DB
row back to `active`; the actual reconnect (`session/resume`/`session/load`) happens
the normal way, the next time someone replies in that session's original thread.

**Starting your own session doesn't let you stop someone else's (D31).** Being in
`agentSessions.allowedUsers` only grants the right to start sessions of your own.
Closing one is a separate, narrower check: only the owner, the person who actually
started that specific session, or someone explicitly listed in the new
`agentSessions.allowedControllers` (a distinct grant — delegating "start/stop on my
behalf" is a bigger trust decision than "can start their own") may close it.
Local-profile-only (D26) — this never touches `mcp/tools.remote.js`/`mcp/http.js`.

**`allowedUsers` doesn't grant access to every registered repo.** Being on the
allowlist only means you may start/resume sessions at all; which named repos
(`core/repos.js`) you may point one at is a separate, optional grant via
`agentSessions.repoAccess`:

```json
"agentSessions": { "allowedUsers": ["U0123ABC", "U0456DEF"], "repoAccess": { "U0456DEF": ["team-slack-bridge"] } }
```

A user with no entry in `repoAccess` (like `U0123ABC` above) stays unrestricted
— this keeps existing installs working unchanged until you opt in per user. The
owner is always unrestricted regardless of this setting.

**Surviving a listener restart (D29)**: a reply in a thread whose session was lost to a
restart (the in-memory state is gone, but `agent_sessions` still has the row) triggers
a resume attempt — `session/resume` first, `session/load` second, whichever the backend
actually advertised support for at connect time. If neither is supported, the reply
falls through to normal message handling exactly as if there had never been a session,
rather than erroring. This is lazy (only on the next reply, never an eager
resume-everything-at-startup pass) and gated by the same D24 allowlist as starting one.

**Context-limit handoff.** ACP's `usage_update` session notification (`used`/`size`
tokens, stable — not an estimate) is tracked per turn. Once a session crosses
`agentSessions.contextWarningThreshold` (default `0.8`), the bridge asks the agent
to self-summarize its progress and next steps, writes that to a handoff file under
`~/.team-slack-bridge/handoffs/`, and posts a warning in the thread with three
options — reply:
- **`here`** (or `new session`) — closes the current session and starts a fresh one
  in the same thread, seeded from the handoff.
- **`new thread`** — ends this session; the reply names the handoff file's path so
  you can start a new one yourself and reference it.
- **`compact`** — asks the agent to trim its own context and keep going. This is a
  best-effort nudge only: ACP has no protocol-level "compact now" request (only an
  agent-initiated `compaction_update` notification, which this bridge does listen
  for and treats as "no longer full" if it ever arrives), so there's no guarantee
  it actually reduces token usage.

Any other reply while a session is in this state gets the same warning resent once
(in case it was missed), then a short "I'm full on context" refusal — it will not
silently keep spending an over-budget context on ordinary replies. `stop`/`exit`
still end the session outright regardless of this state.

**Rewind (approximated).** ACP has no real checkpoint/rewind primitive — no
`session/rewind`, no turn history, nothing (confirmed against the SDK's schema).
Replying `rewind` in an active session's thread instead asks how many exchanges
back (1-10) and whether you want the raw prompt/response text or just a plain-
prose summary, then starts a **new** session in the same thread seeded from that
excerpt of the bridge's own saved transcript — not a true rewind of the original
session's live state, just a workaround built from what the bridge already logged.

## Away mode — approve your own session from Slack (PLAN D34–D40)

You are working locally. You want to go and do something else without the session stalling
on the next permission prompt. Away mode routes those prompts to a Slack DM with
Approve/Deny buttons, so you answer from your phone.

```
                                     ┌─────────────────┐
  your session wants to run Bash ──► │ away mode on?   │ ── no ──► normal local prompt
                                     └────────┬────────┘
                                              │ yes
                                     ┌────────▼────────┐
                                     │ tool gated?     │ ── no ──► allowed, no DM
                                     │ awayMode.       │
                                     │  gatedTools     │
                                     └────────┬────────┘
                                              │ yes
                                     ┌────────▼────────┐
                                     │  Slack DM       │
                                     │ [Approve][Deny] │
                                     └────────┬────────┘
                    ┌─────────────────────────┼─────────────────────────┐
                    ▼                         ▼                         ▼
                 Approve                    Deny              no answer / listener down
                    │                         │                         │
                    ▼                         ▼                         ▼
              tool proceeds            tool blocked         Claude: local prompt (defer)
                                                            others: denied  (see D39)
```

### Two commands

```bash
node cli/hooks-install.js claude      # once per harness — writes its config for you
node cli/away.js on                   # before you walk away
node cli/away.js off                  # when you're back
```

`hooks-install` **merges** into `.claude/settings.json`, so hooks you already have keep
working, and re-running it is idempotent. For OpenCode it drops a stub into
`~/.config/opencode/plugins/`.

### Works on more than Claude Code

| Harness | Adapter | Gate a tool | On timeout |
| --- | --- | --- | --- |
| **Claude Code** | `tsb-hook` (`cli/hook.js`) | `PreToolUse` | **defers** to the local prompt |
| **OpenCode** | `adapters/opencode-plugin.js` | `tool.execute.before` | **denies** |
| Codex, Gemini | ACP axis only, no adapter yet | — | would deny |

The difference is not a preference, it is a capability: Claude Code documents "exit 0 with
no output → continues through the normal permission flow", which is a real third state.
OpenCode's only signal is `throw`, a hard deny. So there is no "ask me locally instead" on
OpenCode, and unknown harnesses default to **deny** — a dead turn is recoverable, a silent
approval while nobody is watching is not (PLAN D39).

### One place to change your mind

Every knob is read fresh on each invocation, so it all applies **mid-session with nothing
to restart**, and none of it lives in a harness-specific file (PLAN D40):

```jsonc
// ~/.team-slack-bridge/slack-config.json
"awayMode": {
  "gatedTools": ["Bash", "Edit", "Write", "NotebookEdit"],  // Bash|bash both match
  "hookTimeoutSeconds": 300,
  "maxContinuations": 3
}
```

### Beyond approvals

- **"What's next?"** — when the session finishes, it DMs you instead of going idle. Reply
  with an instruction to keep it going, or `done` to let it stop. Capped at
  `maxContinuations` so it can't loop forever.
- **Idle and waiting pings** — a DM when a session goes idle, a subagent needs input, or a
  run completes.
- **Autocompact** — you get told it happened. You cannot veto it; no hook mechanism for
  that exists (PLAN D38).

### Before you rely on it

- The **Socket Mode listener must be running** (`node cli/daemon.js start`) — a button
  click is never visible to a poll. The hook checks first and fails fast instead of hanging.
- The hook must resolve the **same `TSB_HOME` as the daemon**, or they use different
  `.ledger.sqlite` files and every ask silently times out.
- Whoever can DM the bot as you becomes the permission authority for that session. Away
  mode reads `config.owner.slackUserId` only — the `agentSessions` allowlists do not grant it.
- **End-to-end verification is still outstanding**, and OpenCode's `session.idle` handling
  is unproven — see `TODO.md`'s pending list before trusting either unattended.

## Connecting multiple AI coding harnesses / multiple Slack accounts (PLAN D21/D22)

Two independent things, both local-only — the remote/hosted `slackbotMcp` profile is
untouched by either. D6 still stands as the **default** there (one deployment, one bot,
one workspace); an opt-in multi-tenant mode now exists for that profile specifically
(`slackbotMcp.tenancy.mode`, D53-D54 — see "Multi-tenancy" under "Runtime Notes"
above), but it's a separate axis from the local multi-harness/multi-account setup
described in this section.

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

**CLI** (`cli/*.js`, `post.js`, `get-user-token.js`): default post-as identity is still
**the bot**, unchanged — posting "as a specific person" requires the explicit
`--as-user` flag, never inferred or defaulted.

**MCP tools** (`slack_post`/`slack_reply`/`slack_dm`): the default is the opposite —
**as you** (`viaBot:false`), not the bot — see D47 in "Capabilities at a glance" above.
This asymmetry between the two surfaces is deliberate (PLAN §18), not an oversight: the
CLI is typically run by one person who already knows which identity they mean; an MCP
tool is typically called by a model, where "default to the shared bot" is the riskier
failure mode on a token used by a whole team.

If you build anything routing requests to different people's tokens on top of either
surface, keep the underlying rule: explicit beats inferred, always.

## Releasing

Publishing to npm is a deliberate, separate step from merging to `main` — pushing to
`main` never publishes anything. `.github/workflows/publish.yml` runs on a pushed
`v*` tag only, using npm's OIDC Trusted Publishing (no `NPM_TOKEN` secret):

```
┌──────────────────┐     ┌─────────────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│  merge to main   │  ▶  │   git tag v0.1.x    │  ▶  │   GitHub Actions     │  ▶  │   npm registry   │
│   (reviewed)     │     │  git push --tags    │     │ (OIDC, no stored     │     │  (--provenance)  │
│                  │     │                     │     │  secret token)       │     │                  │
└──────────────────┘     └─────────────────────┘     └──────────────────────┘     └──────────────────┘
        a plain push to main never reaches this pipeline — only a pushed tag does
```

```bash
# after package.json's version is already bumped and merged to main
git tag v$(node -p "require('./package.json').version")
git push origin --tags
```

The workflow runs the test suite, checks the tag matches `package.json`'s version, and
publishes with `--provenance`. See PLAN.md D43 for why it's tag-triggered rather than
on every push to `main`.

## License

MIT
