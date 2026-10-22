# User-token DM support plan

## Problem observed (2026-10-22)

`node cli/dm.js --as-user` is intended to send a direct message as the local
authorized Slack user. It failed while attempting to DM `U01GDDF0NDR`:

```text
{ "ok": false, "error": "channel_not_found" }
```

The initial cause was a bridge bug: `core/dm.js` opened/reused the DM with the
bot token even when `asUser` was true, then attempted `chat.postMessage` with
the user token. Slack correctly rejects that because a bot↔recipient DM is not
a conversation the human user token owns.

After correcting the ownership/cache logic, the live user-token
`conversations.open` call instead returned:

```text
{ "ok": false, "error": "missing_scope" }
```

The app manifest and `get-user-token.js` currently request only `chat:write`
for user tokens. The manifest already requests `im:write` for bot tokens, but
not for user tokens.

## Goal

Allow the local owner to send and edit direct messages as themselves using
their own `SLACK_USER_TOKEN`, while preserving the existing security boundary:

- local profile only;
- never exposed by `mcp/tools.remote.js` or the hosted HTTP profile;
- no silent bot fallback after an as-user failure;
- each token identity uses its own cached direct-message channel.

## Work items

### 1. Correct token-bound DM conversation ownership

- [x] Change `core/dm.js` so `dm({ asUser: true })` passes the user token to
  `conversations.open`, not the bot token.
- [x] Namespace `dm_channels` cache entries by caller type, e.g.
  `bot:U123` and `user:U123`, so a bot-opened DM is never reused for an
  as-user send.
- [x] Add focused regression coverage in `test/dm-cache.test.js` proving the
  two identities do not share a cached channel.
- [x] Run `node --test test/dm-cache.test.js`.

### 2. Add the required user OAuth scope and reauthorize

- [x] Confirm the exact Slack OAuth scope required for `conversations.open`
  with a user token in the installed app. The live error is `missing_scope`;
  confirmed candidate: `im:write` (Slack's own scope docs: `im:write` covers
  "Start direct messages with people" on a user token, matching
  `conversations.open`/`chat.postMessage` to a DM channel).
- [x] Add the confirmed scope to the `oauth_config.scopes.user` list in
  `config/slack-app-manifest.template.json`. Also added `channels:read`,
  `groups:read`, `im:read`, `mpim:read` for the new `slack_list_channels`
  tool (PLAN D41), and backfilled `search:read` which the manifest already
  listed but `get-user-token.js` never actually requested — a pre-existing
  gap, fixed here since both features touch the same scope list.
- [x] Change `get-user-token.js` so `USER_SCOPES` requests `chat:write`,
  `search:read`, `im:write`, `channels:read`, `groups:read`, `im:read`,
  `mpim:read`.
- [ ] Update the Slack app manifest in Slack and reinstall/re-authorize the
  app. This must be done manually by the owner; never copy a user token into
  source, a plan, chat, logs, or Git.
- [ ] Run `npm run get-user-token` locally to mint a replacement user token.
- [ ] Verify only with `node cli/doctor.js --json`; it must never print the
  token value.

### 3. Verify the full as-user DM flow live

- [ ] Use `node cli/dm.js --user <recipient-id> --as-user --json` to send a
  harmless test DM.
- [ ] Verify the returned Slack message has the local human user as its
  author.
- [ ] Edit that same message with:
  ```bash
  node cli/update.js --channel <channel-id> --ts <message-ts> \
    --text '<updated text>' --as-user --json
  ```
- [ ] Confirm a bot-token edit of that user-authored message fails, preserving
  Slack's same-author identity protection.

### 4. Complete local MCP parity

The local MCP registry exposes `slack_post_as_user`, but its `slack_dm` and
`slack_update_message` wrappers use only the bot token. Add explicit,
separately named local-only tools rather than an ambiguous `asUser` boolean:

- [x] `slack_dm_as_user({ userId, text, dryRun? })`
- [x] `slack_update_message_as_user({ channel, ts, text, dryRun? })`
- [ ] If needed, `slack_delete_message_as_user({ channel, ts, dryRun? })`

Each tool must:

- live in `mcp/tools.local.js` only;
- use `SLACK_USER_TOKEN`;
- have its own schema and tests;
- be absent from `mcp/tools.remote.js` and the hosted HTTP allow-list;
- return a clear `user-token-required` or Slack scope error without falling
  back to bot posting/editing.

### 5. Documentation and safety tests

- [ ] Update README user-token setup with the additional user scope and the
  required reauthorization after a scope change.
- [ ] Document that an as-user failure requires explicit human approval before
  any bot-authored fallback.
- [x] Add MCP registry tests proving the as-user DM/edit tools are local-only.
- [ ] Run the complete test suite, lint/format checks, and a manual
  `--dry-run` for every new CLI/MCP command.

## Acceptance criteria

1. A locally authorized user can send a DM as themselves to a valid Slack
   recipient and edit that same message with the same user token.
2. Bot and user DM channels for the same recipient are never conflated in the
   cache.
3. The missing Slack user-token scope is requested and reauthorized manually;
   no token appears in source control or agent output.
4. User-token DM/edit capabilities are structurally absent from the remote
   MCP and hosted HTTP surfaces.
5. An agent never silently falls back from an as-user action to a bot action.
