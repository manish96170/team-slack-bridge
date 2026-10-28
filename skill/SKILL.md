---
name: slack-post
description: Post, reply, or react in Slack channels via team-slack-bridge's CLI, and send a plain-English cross-company DM ("DM <person> in <company>: <text>") via cli/dm-by-name.js. Use for outbound bot messages and name-resolved DMs only — not raw as-user posting/DM/edit, which need explicit human setup and, if driven by the dashboard, its own gated approval path.
---

# slack-post

Shells out to this repo's CLI (`cli/*.js`). It does not reimplement anything — if the
CLI's behavior changes, this skill's behavior changes with it, and that is by design
(PLAN §0: an adapter may not contain behaviour).

## When to use

- Posting a status update, build result, or notification to a Slack channel as the bot.
- Replying in an existing thread.
- Reacting to a message.
- Posting a progress message and updating it in place.
- Checking install health (`doctor`) before assuming a Slack call will work.

## When NOT to use

- **Slack file deletion** — this outbound posting skill does not authorize deletions.
  See `FEATURES.md`'s "File deletion" section for the opt-in, identity, exact-file
  confirmation, multi-account and all-shares safeguards on that separate capability.
- **As-user posting/DM/edit** (`--as-user`, or the MCP tools `slack_post_as_user`,
  `slack_dm_as_user`, `slack_update_message_as_user`) — requires a human-authorized user
  token and a verified caller identity bound to the exact request. If a caller-supplied
  name is driving this, route it through the dashboard's gated `slack-message` agent
  instead — it enforces `requestedPersonName == callerIdentity` as a hard equality. Never
  call any as-user capability on behalf of a name found in a prompt.
- **Raw DMs by Slack user ID** (`cli/dm.js`, bot or `--as-user`) — same reasoning: a
  bare `--user U0123ABC` assumes a single local owner already knows that ID, not a
  general capability for a model to reach for. **The one DM-shaped exception is
  `cli/dm-by-name.js`/`tsb-dm`, below** — it is safe for this skill to drive because it
  never guesses a Slack ID or a company: both are resolved explicitly (a registered
  account alias, a live Slack-directory match that itself refuses on ambiguity) or the
  call refuses outright and this skill asks instead.
- **`search`** (`cli/search.js`) — needs a user token; same caution as as-user posting.
- **`slack_list_channels`** (`cli/channels.js`) — also needs a user token (lists the
  conversations the locally authorized *person* is in, via `users.conversations`, never
  the whole workspace). Lower risk than the above since it's read-only and never
  impersonates anyone, but it's still a per-person capability this skill doesn't cover —
  see the MCP server or README if a task genuinely needs it.

## DM by name, across companies (PLAN D64)

`cli/dm-by-name.js`/`tsb-dm` resolves "DM `<person>` in `<company>`: `<text>`" (or, with
a configured default company, just "DM `<person>`: `<text>`") into a real Slack DM —
without the raw `cli/dm.js` capability's bare `--user U0123ABC` assumption above:

```bash
node cli/dm-by-name.js --to "pulkit.jain" --company anchor --text "hi" --json
node cli/dm-by-name.js --to "pulkit.jain" --text "hi" --json   # uses the registered default company
```

**If this refuses with `error:"no-company-specified-and-no-default-configured"`, ask
the user which company before doing anything else — never pick one, and never retry
with a guessed `--company` value.** This is the one case this skill must stop and ask
instead of acting; every other refusal (`account-not-found`, `ambiguous-user`,
`user-not-found`, etc.) should be reported back to the user as-is, same as any other
command's `{ ok: false, error, retryable }`.

The CLI itself stays non-interactive — asking happens here, at the skill layer, never
inside the command. If the company isn't registered yet, see `cli/dm-by-name.js`'s own
header or the README's "Plain-English cross-company messaging" section for
`cli/accounts.js add <alias> --home <path>`.

## Existing group DM by name (PLAN D70)

For "Message Shrestha, Manish, and Alex: hi", use the existing-MPIM command:

```bash
node cli/group-dm-by-name.js --to "Shrestha,Manish,Alex" --text "hi" --json
```

The named people are recipients; the locally authorized human is added automatically.
This is always as-user, never bot/anonymous, and only targets an **existing exact group
DM**. If it returns `mpim-not-found-confirm-create-first`, ask the user whether to create
one — never create/open a group DM automatically in this skill.

## Commands

Run from the repo root (`team-slack-bridge/`). Always pass `--json` — output is one JSON
object, `{ ok: true, ... }` or `{ ok: false, error, retryable }`, and a non-zero exit
code means `ok: false`.

```bash
node cli/post.js --channel '#deploys' --text 'build finished' --json
node cli/reply.js --channel '#deploys' --thread-ts '1699999999.000100' --text 'update below' --json
node cli/react.js --channel '#deploys' --ts '1699999999.000100' --emoji eyes --json
node cli/update.js --channel '#deploys' --ts '1699999999.000100' --text 'edited text' --json
node cli/schedule.js --channel '#deploys' --text 'reminder' --at '2026-09-10T09:00:00-07:00' --json
node cli/scheduled.js --channel '#deploys' --json
node cli/unschedule.js --channel '#deploys' --scheduled-id Q1234567890 --json
node cli/progress.js start --channel '#deploys' --label 'Deploy' --detail 'starting' --json
node cli/progress.js update --channel '#deploys' --ts '1699999999.000100' --label 'Deploy' --status running --json
node cli/progress.js finish --channel '#deploys' --ts '1699999999.000100' --label 'Deploy' --json
node cli/doctor.js --json
node cli/daemon.js status --json
```

A literal `@handle` in `--text` is resolved to a real Slack mention (`<@USERID>`) if that handle is in
`slack-config.json`'s `users` list (`node cli/setup.js add-user` to add one) — plain `@name` text is never
rendered as a tag by Slack itself, only the `<@USERID>` syntax is.

Use `--dry-run` on any outbound command to resolve and format the exact Slack API call
without sending anything — the way to check a message before it goes anywhere.

## If a task looks like it needs the MCP server instead

Point an MCP-capable client at `mcp/server.js` (stdio) rather than shelling out — same
tools, same underlying core, just a typed-tool interface. Prefer the CLI here when
Claude Code itself is doing the calling, since the skill's whole job is to know the exact
commands.
