# team-slack-bridge

Post to Slack — as a bot, or explicitly as a specific authorized person — and DM,
from any script, agent, or CI job. Standalone: no dependency on any particular
orchestration system, AI agent framework, or dashboard. Outbound only for now
(reading/listening to Slack is a separate, not-yet-built concern).

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

## Scope note

Default post-as identity is always **the bot** — posting "as a specific person"
requires the explicit `--as-user` flag, never inferred or defaulted. If you build
anything routing requests to different people's tokens, keep that rule: explicit
beats inferred, always.

## License

MIT
