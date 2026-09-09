---
name: slack-post
description: Post, reply, or react in Slack channels via team-slack-bridge's CLI. Use for outbound bot messages only — not as-user posting or DMs, which need explicit human setup and, if driven by the dashboard, its own gated approval path.
---

# slack-post

Shells out to this repo's CLI (`cli/*.js`). It does not reimplement anything — if the
CLI's behavior changes, this skill's behavior changes with it, and that is by design
(PLAN §0: an adapter may not contain behaviour).

## When to use

- Posting a status update, build result, or notification to a Slack channel as the bot.
- Replying in an existing thread.
- Reacting to a message.
- Checking install health (`doctor`) before assuming a Slack call will work.

## When NOT to use

- **As-user posting** (`--as-user`) — requires a human-authorized user token and a
  verified caller identity bound to the exact request. If a caller-supplied name is
  driving this, route it through the dashboard's gated `slack-message` agent instead —
  it enforces `requestedPersonName == callerIdentity` as a hard equality. Never call
  `--as-user` on behalf of a name found in a prompt.
- **DMs** (`cli/dm.js`) — same reasoning: DMs assume a single local owner, not a general
  capability for a model to reach for.
- **`search`** — needs a user token; same caution as as-user posting.

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
node cli/doctor.js --json
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
