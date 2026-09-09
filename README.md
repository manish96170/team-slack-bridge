# team-slack-bridge

Post to Slack — as a bot, or explicitly as a specific authorized person — and DM,
from any script, agent, or CI job. Standalone: no dependency on any particular
orchestration system, AI agent framework, or dashboard. Outbound only for now
(reading/listening to Slack is a separate, not-yet-built concern).

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

**Not yet built** (tracked in `PLAN.md` §8/§9, gated behind two open questions — Bolt vs.
hand-rolled Socket Mode, and where the listener runs): the inbound listener, the
DM-reading gate, dashboard wiring, and the remote/hosted MCP profile.

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

1. Create a Slack app as a **Blank app** (not "Starter app" — that scaffolds a hosted
   event-listener framework you don't need for outbound-only use). Under **OAuth &
   Permissions -> Scopes**, add these **Bot Token Scopes**:
   - `chat:write`, `chat:write.customize` — post messages as the bot
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

2. Install the app to your workspace. Invite the bot to any channel you want it posting
   in (`/invite @your-app-name`). To DM the bot yourself, search its name in Slack or
   find it under **Apps** in the sidebar — no separate "invite to DM" step exists.
3. `cp .env.example .env` — fill in `SLACK_BOT_TOKEN` (from Install to Workspace) and,
   if you want the as-user capability, `SLACK_CLIENT_ID`/`SLACK_CLIENT_SECRET` (from
   Basic Information). **Edit `.env` directly — don't paste token values anywhere
   they'll be logged or shared.**
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
```

## Future: robustness and inbound listening (not built, noted for later)

**Adopt soon, low risk — `@slack/web-api`.** The official typed Web API client (what
Bolt itself is built on) — correct request encoding, built-in retry/rate-limit (429)
handling, typed responses. This would have caught the `conversations.list`
types-filter-silently-ignored-on-JSON-body bug this repo hit and fixed by hand in
`verify-dm.js`. Smaller than adopting Bolt (no event-listener/OAuth-app scaffolding) —
worth swapping in for `post.js`/`verify-dm.js`'s raw `fetch` calls whenever this repo
gets touched again, independent of whether inbound ever gets built.

**Adopt when inbound gets built — `@slack/bolt`.** Its event listeners are
**push**-based (Events API / Socket Mode), which is the actual fix for a real
password-gate design bug found during review: a gate that checks before a *pull* call
(`conversations.history`) never runs on the path Slack actually uses to deliver a DM (a
*push* event). Don't build a hand-rolled inbound poller; use Bolt's listener model from
the start once this phase is prioritized. (Bolt wraps `@slack/web-api`, so adopting the
client first is not wasted work.)

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
