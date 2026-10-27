// The full local tool registry (PLAN §6.3, §5). One tool per core function.
// User-token tools are separate from their bot equivalents because identity
// capabilities cannot be silently substituted. `slack_post_as_user`,
// `slack_react_as_user`, `slack_unreact_as_user`, `slack_dm`,
// `slack_dm_as_user`, `slack_update_message_as_user`,
// `slack_delete_message_as_user`, `slack_search`, `slack_list_channels`,
// `slack_upload_file`, `slack_upload_file_as_user`, and `slack_lookup_user`
// are exactly what mcp/tools.remote.js must NOT import. The upload tools
// additionally read an arbitrary local `filePath`, which would be a local-file
// read primitive in a remote profile. `slack_lookup_user` can use either
// token (tokenSource:"bot"/"user", explicit, never a silent fallback) but
// is local-only for a different reason — see D50/D51 below.
//
// D47: `slack_post`/`slack_reply`/`slack_dm` default to sending AS THE
// LOCAL USER (`viaBot:false`), not as the bot — reversed from the original
// bot-only behavior, on request, because a bot-token send is invisible to
// its own sender (no native Slack message of theirs to see/edit/delete)
// and carries no indication of who triggered it when a bot token is shared
// across a team. `viaBot:true` opts back into the bot path explicitly, and
// gets a `core/sender.js` attribution footer plus a `core/local-audit.js`
// journal entry — see those files for the reasoning. `slack_post_as_user`/
// `slack_dm_as_user` remain as explicit aliases for the same (now default)
// behavior.
//
// D48: a `viaBot:true` send from an install that cannot identify its own
// sender (`core/sender.js`'s `isAuthorizedSender`) is REFUSED unless the
// caller explicitly passes `anonymousMessage:true` — an unidentified
// install has no business speaking as "the bot" by accident. When the
// sender IS identified, they get a private tracking DM of every viaBot
// send (`core/tracking.js`): a "You have sent ... via Bot" parent message
// with the actual text as a single threaded reply underneath, kept even
// when `anonymousMessage:true` hid the attribution from the public
// message — "withheld from the recipient" and "invisible to the sender"
// are different things, and this only ever relaxes the first. A
// bot-token edit/delete on the original propagates to that tracking copy
// (edit touches only the threaded reply; delete removes the whole tracking
// DM). All of it can be turned off per install via `botSendTracking.enabled:
// false` (core/identity.js) for anyone who doesn't want a tracking copy at
// all; it never runs on the (now default) as-user path, so that path's
// latency is unaffected.
//
// D50: `slack_lookup_user` is a SEPARATE capability from `slack_resolve_user`
// above — a live Slack API call (`core/directory.js`), not a config-file
// lookup, for people who aren't in slack-config.json's `users` list.
// Local-only, since an unrestricted directory search is a workspace-
// enumeration primitive the same way unrestricted `resolveUser` was (D20).
//
// D51: `slack_lookup_user` can use EITHER token, via an explicit
// `tokenSource:"bot"|"user"` argument (originally defaulted `"bot"`, see
// D60 below for why that default flipped) — never a silent fallback
// between the two, same principle as every other bot/user split in this
// registry. The resolved `tokenSource` is always echoed back in the
// result so a caller never has to infer which identity answered.
//
// D60: `slack_react`/`slack_unreact`/`slack_update_message`/
// `slack_delete_message` now default (`viaBot:false`) to the locally
// authorized human (SLACK_USER_TOKEN) too, matching D47's slack_post/
// slack_reply/slack_dm precedent — `viaBot:true` opts back into the
// shared bot token. `slack_lookup_user`'s default also flipped, from
// `tokenSource:"bot"` to `tokenSource:"user"`. The `_as_user` tools
// (`slack_react_as_user`, `slack_unreact_as_user`,
// `slack_update_message_as_user`, `slack_delete_message_as_user`) remain
// as explicit aliases for this now-default behavior, same posture D47
// left `slack_post_as_user`/`slack_dm_as_user` in. Deliberately NOT
// extended to the standalone CLI scripts (`cli/react.js`, `cli/update.js`,
// `cli/delete.js`, `cli/lookup-user.js`) — their `--as-user` flag still
// means "switch to the user token, bot is the default," unchanged. This
// mirrors D47 itself, which only ever changed the MCP tool layer
// (`mcp/tools.local.js`) and never touched `cli/post.js`/`cli/dm.js`'s own
// bot-default `--as-user` flag; following that same precedent here keeps
// one consistent asymmetry instead of introducing a second, different one.
// `mcp/tools.remote.js` is untouched by this decision — the hosted profile
// has no user tokens at all (D20), so there is nothing there to default
// away from.

import { postToChannel, reply, react, unreact, updateMessage, deleteMessage } from '../core/post.js'
import { dm } from '../core/dm.js'
import { queryMessages, getThread } from '../core/query.js'
import { search } from '../core/search.js'
import { listMyChannels } from '../core/channels.js'
import { uploadFile } from '../core/files.js'
import { resolveUser } from '../core/identity.js'
import { lookupUser } from '../core/directory.js'
import { doctor } from '../core/doctor.js'
import { scheduleMessage, deleteScheduledMessage, listScheduledMessages } from '../core/schedule.js'
import { ask } from '../core/ask.js'
import { startProgress, updateProgress, finishProgress } from '../core/progress.js'
import { publishHome } from '../core/home.js'
import { createAgentSession } from '../core/agent-sessions.js'
import { getSenderInfo, withSenderAttribution, isAuthorizedSender, resolveAnonymousMessage } from '../core/sender.js'
import { recordLocalAudit } from '../core/local-audit.js'
import { isTrackingEnabled, echoBotSendToSender, propagateUpdateToTracking, propagateDeleteToTracking } from '../core/tracking.js'
import { schemas } from './schema.js'

// Surfaced in the MCP `initialize` response's `instructions` field (D67, on
// request — found live: a calling agent explicitly set viaBot:true and
// anonymousMessage:true on a plain "send a status update" DM, unprompted,
// even though both are opt-in and documented as such in every affected
// tool/field description). Per-tool descriptions are read only when a model
// is already considering that specific tool/field; `instructions` is read
// once, before any tool call, by MCP clients that support it — the
// strongest lever available here, though still advisory, not an
// enforcement mechanism (there is no way to force a client to read or obey
// it).
export const MCP_INSTRUCTIONS =
  'slack_post/slack_reply/slack_dm default to sending AS THE LOCALLY AUTHORIZED HUMAN, not the shared bot. ' +
  'viaBot:true and anonymousMessage:true are opt-in for when a human explicitly asks for a bot-branded or ' +
  'anonymous message in THIS request — never set either on your own initiative, including for routine status ' +
  'updates, completion notices, or production/approval messages. If a viaBot send is refused as unauthorized ' +
  '(not-authorized-to-send-as-bot-...), report that refusal back to the human and let them decide; do not retry ' +
  'with anonymousMessage:true yourself.'

export const tools = {
  slack_post: {
    name: 'slack_post',
    description:
      'Post a message to a Slack channel. Defaults (viaBot:false) to sending as the locally authorized human (SLACK_USER_TOKEN) — a real Slack message of yours, visible to you with native edit/delete. Pass viaBot:true to send as the shared bot instead (SLACK_BOT_TOKEN); refused unless this install can identify its sender OR anonymousMessage:true is passed. A viaBot send gets a "sent via bot by" attribution footer (unless anonymousMessage:true) and is journaled to local_audit; if the sender is identified, they also get a private tracking DM of what was sent and where, unless botSendTracking is disabled. "@handle" in text is resolved to a real Slack mention against slack-config.json. IMPORTANT: viaBot/anonymousMessage are opt-in for when a human explicitly asks for a bot-branded or anonymous message — never set them on your own initiative, including for routine status updates, completion notices, or production/approval messages. If a viaBot send is refused as unauthorized, report the refusal back to the human; do not retry with anonymousMessage:true yourself.',
    inputSchema: schemas.slack_post,
    handler: async (args, ctx) => {
      const viaBot = !!args.viaBot
      const anonymousMessage = resolveAnonymousMessage(args.anonymousMessage, ctx.config)
      const authorized = isAuthorizedSender(ctx.config)
      const sender = getSenderInfo(ctx.config)

      if (viaBot && !authorized && !anonymousMessage) {
        return { ok: false, error: 'not-authorized-to-send-as-bot-pass-anonymousMessage-true-to-send-anonymously', retryable: false }
      }
      const token = viaBot ? ctx.env.SLACK_BOT_TOKEN : ctx.env.SLACK_USER_TOKEN
      if (!token && !args.dryRun) {
        return { ok: false, error: viaBot ? 'bot-token-required' : 'user-token-required-pass-viaBot-true-to-send-as-the-bot-instead', retryable: false }
      }

      const text = viaBot ? withSenderAttribution(args.text, ctx.config, { anonymous: anonymousMessage }) : args.text
      const result = await postToChannel({
        token,
        channel: args.channel,
        text,
        threadTs: args.threadTs,
        idempotencyKey: args.idempotencyKey,
        ledgerPath: ctx.dbPath,
        config: ctx.config,
        dryRun: args.dryRun,
      })

      if (viaBot && !args.dryRun) {
        recordLocalAudit({ dbPath: ctx.dbPath, sender, tool: 'slack_post', viaBot, ok: result.ok, error: result.error, channel: result.channel || args.channel, ts: result.ts })
        if (result.ok && authorized && isTrackingEnabled(ctx.config)) {
          await echoBotSendToSender({
            botToken: ctx.env.SLACK_BOT_TOKEN,
            dbPath: ctx.dbPath,
            config: ctx.config,
            senderId: sender.slackUserId,
            kind: 'channel',
            channel: args.channel,
            text,
            originalChannel: result.channel,
            originalTs: result.ts,
            anonymous: anonymousMessage,
          }).catch(() => {})
        }
      }
      return result
    },
  },
  slack_reply: {
    name: 'slack_reply',
    description:
      'Reply in a Slack thread. Defaults (viaBot:false) to replying as the locally authorized human (SLACK_USER_TOKEN). Pass viaBot:true to reply as the shared bot instead; refused unless this install can identify its sender OR anonymousMessage:true is passed. A viaBot reply carries an attribution footer (unless anonymousMessage:true) and is journaled to local_audit; if the sender is identified, they also get a private tracking DM, unless botSendTracking is disabled. "@handle" in text is resolved to a real Slack mention against slack-config.json. IMPORTANT: viaBot/anonymousMessage are opt-in for when a human explicitly asks for a bot-branded or anonymous message — never set them on your own initiative. If a viaBot reply is refused as unauthorized, report the refusal back to the human; do not retry with anonymousMessage:true yourself.',
    inputSchema: schemas.slack_reply,
    handler: async (args, ctx) => {
      const viaBot = !!args.viaBot
      const anonymousMessage = resolveAnonymousMessage(args.anonymousMessage, ctx.config)
      const authorized = isAuthorizedSender(ctx.config)
      const sender = getSenderInfo(ctx.config)

      if (viaBot && !authorized && !anonymousMessage) {
        return { ok: false, error: 'not-authorized-to-send-as-bot-pass-anonymousMessage-true-to-send-anonymously', retryable: false }
      }
      const token = viaBot ? ctx.env.SLACK_BOT_TOKEN : ctx.env.SLACK_USER_TOKEN
      if (!token && !args.dryRun) {
        return { ok: false, error: viaBot ? 'bot-token-required' : 'user-token-required-pass-viaBot-true-to-send-as-the-bot-instead', retryable: false }
      }

      const text = viaBot ? withSenderAttribution(args.text, ctx.config, { anonymous: anonymousMessage }) : args.text
      const result = await reply({
        token,
        channel: args.channel,
        threadTs: args.threadTs,
        text,
        idempotencyKey: args.idempotencyKey,
        ledgerPath: ctx.dbPath,
        config: ctx.config,
        dryRun: args.dryRun,
      })

      if (viaBot && !args.dryRun) {
        recordLocalAudit({ dbPath: ctx.dbPath, sender, tool: 'slack_reply', viaBot, ok: result.ok, error: result.error, channel: result.channel || args.channel, ts: result.ts })
        if (result.ok && authorized && isTrackingEnabled(ctx.config)) {
          await echoBotSendToSender({
            botToken: ctx.env.SLACK_BOT_TOKEN,
            dbPath: ctx.dbPath,
            config: ctx.config,
            senderId: sender.slackUserId,
            kind: 'channel',
            channel: `${args.channel} (thread ${args.threadTs})`,
            text,
            originalChannel: result.channel,
            originalTs: result.ts,
            anonymous: anonymousMessage,
          }).catch(() => {})
        }
      }
      return result
    },
  },
  slack_react: {
    name: 'slack_react',
    description: 'Add an emoji reaction. Defaults (viaBot:false) to reacting as the locally authorized human (SLACK_USER_TOKEN). Pass viaBot:true to react as the shared bot instead (SLACK_BOT_TOKEN).',
    inputSchema: schemas.slack_react,
    handler: (args, ctx) =>
      react({ token: args.viaBot ? ctx.env.SLACK_BOT_TOKEN : ctx.env.SLACK_USER_TOKEN, channel: args.channel, ts: args.ts, emoji: args.emoji, dryRun: args.dryRun }),
  },
  slack_react_as_user: {
    name: 'slack_react_as_user',
    description: 'Add an emoji reaction as the locally authorized user. Requires a locally configured user token. Explicit alias for slack_react\'s (now default) behavior.',
    inputSchema: schemas.slack_react_as_user,
    handler: (args, ctx) =>
      react({ token: ctx.env.SLACK_USER_TOKEN, channel: args.channel, ts: args.ts, emoji: args.emoji, dryRun: args.dryRun }),
  },
  slack_unreact: {
    name: 'slack_unreact',
    description: 'Remove a reaction. Defaults (viaBot:false) to removing the locally authorized human\'s own reaction (SLACK_USER_TOKEN). Pass viaBot:true to remove this installation\'s bot reaction instead (SLACK_BOT_TOKEN).',
    inputSchema: schemas.slack_unreact,
    handler: (args, ctx) =>
      unreact({ token: args.viaBot ? ctx.env.SLACK_BOT_TOKEN : ctx.env.SLACK_USER_TOKEN, channel: args.channel, ts: args.ts, emoji: args.emoji, dryRun: args.dryRun }),
  },
  slack_unreact_as_user: {
    name: 'slack_unreact_as_user',
    description: 'Remove the locally authorized user\'s emoji reaction from a message. Requires a locally configured user token. Explicit alias for slack_unreact\'s (now default) behavior.',
    inputSchema: schemas.slack_unreact_as_user,
    handler: (args, ctx) =>
      unreact({ token: ctx.env.SLACK_USER_TOKEN, channel: args.channel, ts: args.ts, emoji: args.emoji, dryRun: args.dryRun }),
  },
  slack_update_message: {
    name: 'slack_update_message',
    description:
      'Edit a message. Defaults (viaBot:false) to editing as the locally authorized human (SLACK_USER_TOKEN) — use this for a message created by the (also default) as-user slack_post/slack_reply/slack_dm. Pass viaBot:true to edit a message previously posted by this install\'s bot token instead; if that bot send had a tracking copy (core/tracking.js), the threaded reply there is edited to match.',
    inputSchema: schemas.slack_update_message,
    handler: async (args, ctx) => {
      const viaBot = !!args.viaBot
      const result = await updateMessage({
        token: viaBot ? ctx.env.SLACK_BOT_TOKEN : ctx.env.SLACK_USER_TOKEN,
        channel: args.channel,
        ts: args.ts,
        text: args.text,
        ledgerPath: ctx.dbPath,
        config: ctx.config,
        dryRun: args.dryRun,
      })
      if (viaBot && result.ok && !args.dryRun) {
        await propagateUpdateToTracking({ botToken: ctx.env.SLACK_BOT_TOKEN, dbPath: ctx.dbPath, config: ctx.config, channel: args.channel, ts: args.ts, text: args.text }).catch(() => {})
      }
      return result
    },
  },
  slack_update_message_as_user: {
    name: 'slack_update_message_as_user',
    description: 'Edit a message previously posted by the locally authorized user. Requires a locally configured user token. Explicit alias for slack_update_message\'s (now default) behavior.',
    inputSchema: schemas.slack_update_message_as_user,
    handler: (args, ctx) =>
      updateMessage({
        token: ctx.env.SLACK_USER_TOKEN,
        channel: args.channel,
        ts: args.ts,
        text: args.text,
        config: ctx.config,
        dryRun: args.dryRun,
      }),
  },
  slack_delete_message: {
    name: 'slack_delete_message',
    description:
      'Delete a message. Defaults (viaBot:false) to deleting as the locally authorized human (SLACK_USER_TOKEN) — use this for a message created by the (also default) as-user slack_post/slack_reply/slack_dm. Pass viaBot:true to delete a message previously posted by this install\'s bot token instead; if that bot send had a tracking copy (core/tracking.js), the whole tracking DM (parent label + threaded reply) is deleted too.',
    inputSchema: schemas.slack_delete_message,
    handler: async (args, ctx) => {
      const viaBot = !!args.viaBot
      const result = await deleteMessage({ token: viaBot ? ctx.env.SLACK_BOT_TOKEN : ctx.env.SLACK_USER_TOKEN, channel: args.channel, ts: args.ts, ledgerPath: ctx.dbPath, dryRun: args.dryRun })
      if (viaBot && result.ok && !args.dryRun) {
        await propagateDeleteToTracking({ botToken: ctx.env.SLACK_BOT_TOKEN, dbPath: ctx.dbPath, channel: args.channel, ts: args.ts }).catch(() => {})
      }
      return result
    },
  },
  slack_delete_message_as_user: {
    name: 'slack_delete_message_as_user',
    description:
      'Delete a message previously posted by the locally authorized user. Requires a locally configured user token. Explicit alias for slack_delete_message\'s (now default) behavior.',
    inputSchema: schemas.slack_delete_message_as_user,
    handler: (args, ctx) => deleteMessage({ token: ctx.env.SLACK_USER_TOKEN, channel: args.channel, ts: args.ts, dryRun: args.dryRun }),
  },
  slack_dm: {
    name: 'slack_dm',
    description:
      'Send a DM. Defaults (viaBot:false) to sending as the locally authorized human (SLACK_USER_TOKEN + user-token DM scope) so the recipient sees a real DM from you. Pass viaBot:true to send as the shared bot instead; refused unless this install can identify its sender OR anonymousMessage:true is passed. A viaBot DM carries an attribution footer (unless anonymousMessage:true) and is journaled to local_audit; if the sender is identified, they also get a private tracking DM of what was sent and to whom, unless botSendTracking is disabled. IMPORTANT: viaBot/anonymousMessage are opt-in for when a human explicitly asks for a bot-branded or anonymous DM — never set them on your own initiative, including for routine status updates, completion notices, or production/approval messages; a plain "send/DM X" request should go as the human by default. If a viaBot send is refused as unauthorized, report the refusal back to the human; do not retry with anonymousMessage:true yourself.',
    inputSchema: schemas.slack_dm,
    handler: async (args, ctx) => {
      const viaBot = !!args.viaBot
      const anonymousMessage = resolveAnonymousMessage(args.anonymousMessage, ctx.config)
      const authorized = isAuthorizedSender(ctx.config)
      const sender = getSenderInfo(ctx.config)

      if (viaBot && !authorized && !anonymousMessage) {
        return { ok: false, error: 'not-authorized-to-send-as-bot-pass-anonymousMessage-true-to-send-anonymously', retryable: false }
      }

      const text = viaBot ? withSenderAttribution(args.text, ctx.config, { anonymous: anonymousMessage }) : args.text
      const result = await dm({
        botToken: ctx.env.SLACK_BOT_TOKEN,
        userToken: ctx.env.SLACK_USER_TOKEN,
        userId: args.userId,
        text,
        asUser: !viaBot,
        config: ctx.config,
        dbPath: ctx.dbPath,
        dryRun: args.dryRun,
      })

      if (viaBot && !args.dryRun) {
        recordLocalAudit({ dbPath: ctx.dbPath, sender, tool: 'slack_dm', viaBot, ok: result.ok, error: result.error, channel: result.channel, ts: result.ts })
        if (result.ok && authorized && isTrackingEnabled(ctx.config)) {
          await echoBotSendToSender({
            botToken: ctx.env.SLACK_BOT_TOKEN,
            dbPath: ctx.dbPath,
            config: ctx.config,
            senderId: sender.slackUserId,
            kind: 'dm',
            targetUserId: args.userId,
            text,
            originalChannel: result.channel,
            originalTs: result.ts,
            anonymous: anonymousMessage,
          }).catch(() => {})
        }
      }
      return result
    },
  },
  slack_dm_as_user: {
    name: 'slack_dm_as_user',
    description: 'Send a DM as the locally authorized user. Requires a locally configured user token and user-token DM scope.',
    inputSchema: schemas.slack_dm_as_user,
    handler: (args, ctx) =>
      dm({
        userToken: ctx.env.SLACK_USER_TOKEN,
        userId: args.userId,
        text: args.text,
        asUser: true,
        config: ctx.config,
        dbPath: ctx.dbPath,
        dryRun: args.dryRun,
      }),
  },
  slack_post_as_user: {
    name: 'slack_post_as_user',
    description: 'Post to a channel as the authorized user. Requires a locally configured user token. Local only.',
    inputSchema: schemas.slack_post_as_user,
    handler: (args, ctx) =>
      postToChannel({
        token: ctx.env.SLACK_USER_TOKEN,
        channel: args.channel,
        text: args.text,
        threadTs: args.threadTs,
        config: ctx.config,
        dryRun: args.dryRun,
      }),
  },
  slack_query_messages: {
    name: 'slack_query_messages',
    description: 'Read recent channel history.',
    inputSchema: schemas.slack_query_messages,
    handler: (args, ctx) =>
      queryMessages({ token: ctx.env.SLACK_BOT_TOKEN, channel: args.channel, sinceMinutes: args.sinceMinutes, limit: args.limit }),
  },
  slack_get_thread: {
    name: 'slack_get_thread',
    description: "Read a thread's replies.",
    inputSchema: schemas.slack_get_thread,
    handler: (args, ctx) => getThread({ token: ctx.env.SLACK_BOT_TOKEN, channel: args.channel, threadTs: args.threadTs }),
  },
  slack_search: {
    name: 'slack_search',
    description: 'Search messages. Requires a user token. Local only.',
    inputSchema: schemas.slack_search,
    handler: (args, ctx) => search({ userToken: ctx.env.SLACK_USER_TOKEN, query: args.query }),
  },
  slack_list_channels: {
    name: 'slack_list_channels',
    description:
      "List the Slack conversations the locally authorized user is a member of (not the whole workspace). Requires a locally configured user token. Local only.",
    inputSchema: schemas.slack_list_channels,
    handler: (args, ctx) => listMyChannels({ token: ctx.env.SLACK_USER_TOKEN, types: args.types, limit: args.limit, cursor: args.cursor }),
  },
  slack_upload_file: {
    name: 'slack_upload_file',
    description:
      'Upload a local file (e.g. a screenshot or video) as the bot, optionally sharing it straight into a channel/thread. Reads from the local filesystem. Local only.',
    inputSchema: schemas.slack_upload_file,
    handler: (args, ctx) =>
      uploadFile({
        token: ctx.env.SLACK_BOT_TOKEN,
        filePath: args.filePath,
        filename: args.filename,
        title: args.title,
        channel: args.channel,
        threadTs: args.threadTs,
        dryRun: args.dryRun,
      }),
  },
  slack_upload_file_as_user: {
    name: 'slack_upload_file_as_user',
    description:
      'Upload a local file as the authorized user, optionally sharing it straight into a channel/thread — e.g. attaching screenshots/video evidence under an as-user MR announcement. Requires a locally configured user token. Local only.',
    inputSchema: schemas.slack_upload_file_as_user,
    handler: (args, ctx) =>
      uploadFile({
        token: ctx.env.SLACK_USER_TOKEN,
        filePath: args.filePath,
        filename: args.filename,
        title: args.title,
        channel: args.channel,
        threadTs: args.threadTs,
        dryRun: args.dryRun,
      }),
  },
  slack_resolve_user: {
    name: 'slack_resolve_user',
    description: 'Resolve a configured handle, name, or display name to a Slack user ID.',
    inputSchema: schemas.slack_resolve_user,
    handler: (args, ctx) => resolveUser(args.handle, ctx.config),
  },
  slack_lookup_user: {
    name: 'slack_lookup_user',
    description:
      'Look up a Slack workspace member who is NOT necessarily in slack-config.json, via a live Slack API call (users.info / users.lookupByEmail / users.list). Defaults to the locally authorized human (tokenSource:"user"); pass tokenSource:"bot" to use SLACK_BOT_TOKEN instead — always explicit, never a silent fallback, and the resolved tokenSource is echoed back in the result. mode:"auto" (default) infers id/email/handle from the query shape; "id" forces users.info, "email" forces users.lookupByEmail, and "handle"/"name" both search the (cached) full directory for an exact, normalized match against the Slack handle, display name, and real name. Deleted users and bots are excluded by default. More than one match refuses with error:"ambiguous-user" and lists every match rather than guessing. Email is omitted from the result unless includeEmail:true, to minimize unnecessary PII exposure. This never writes to slack-config.json.',
    inputSchema: schemas.slack_lookup_user,
    handler: (args, ctx) => {
      const tokenSource = args.tokenSource === 'bot' ? 'bot' : 'user'
      const token = tokenSource === 'user' ? ctx.env.SLACK_USER_TOKEN : ctx.env.SLACK_BOT_TOKEN
      return lookupUser({
        query: args.query,
        mode: args.mode,
        includeEmail: !!args.includeEmail,
        token,
        tokenSource,
        ttlMs: ctx.config?.directoryLookup?.cacheTtlMs,
      })
    },
  },
  slack_doctor: {
    name: 'slack_doctor',
    description: 'Report install health — token presence, auth, and config summary. Never a token value.',
    inputSchema: schemas.slack_doctor,
    handler: (args, ctx) => doctor({ env: ctx.env, config: ctx.config, profile: 'local' }).then(report => ({ ok: true, ...report })),
  },
  slack_schedule_message: {
    name: 'slack_schedule_message',
    description: 'Schedule a message to post to a channel at a future time (postAt: ISO timestamp or Unix seconds, 10s-120d out).',
    inputSchema: schemas.slack_schedule_message,
    handler: (args, ctx) =>
      scheduleMessage({
        token: args.asUser ? ctx.env.SLACK_USER_TOKEN : ctx.env.SLACK_BOT_TOKEN,
        channel: args.channel,
        text: args.text,
        threadTs: args.threadTs,
        postAt: args.postAt,
        dryRun: args.dryRun,
      }),
  },
  slack_delete_scheduled_message: {
    name: 'slack_delete_scheduled_message',
    description: 'Cancel a previously scheduled message before it posts.',
    inputSchema: schemas.slack_delete_scheduled_message,
    handler: (args, ctx) =>
      deleteScheduledMessage({
        token: args.asUser ? ctx.env.SLACK_USER_TOKEN : ctx.env.SLACK_BOT_TOKEN,
        channel: args.channel,
        scheduledMessageId: args.scheduledMessageId,
        dryRun: args.dryRun,
      }),
  },
  slack_list_scheduled_messages: {
    name: 'slack_list_scheduled_messages',
    description: 'List messages currently scheduled but not yet posted.',
    inputSchema: schemas.slack_list_scheduled_messages,
    handler: (args, ctx) =>
      listScheduledMessages({ token: args.asUser ? ctx.env.SLACK_USER_TOKEN : ctx.env.SLACK_BOT_TOKEN, channel: args.channel, limit: args.limit }),
  },
  slack_ask: {
    name: 'slack_ask',
    description:
      "Ask the session's owner a question via Slack DM and BLOCK until answered. kind:'approval' shows Approve/Deny buttons but requires the Socket Mode listener to be running to capture the click; kind:'question' (default) accepts a free-text reply and works with captureMode:'poll' too if no listener is running.",
    inputSchema: schemas.slack_ask,
    handler: (args, ctx) =>
      ask({
        botToken: ctx.env.SLACK_BOT_TOKEN,
        userId: args.userId,
        question: args.question,
        kind: args.kind,
        options: args.options,
        dbPath: ctx.dbPath,
        timeoutSeconds: args.timeoutSeconds,
        captureMode: args.captureMode,
      }),
  },
  slack_progress_start: {
    name: 'slack_progress_start',
    description: 'Post a progress message that can later be updated in place.',
    inputSchema: schemas.slack_progress_start,
    handler: (args, ctx) =>
      startProgress({
        token: ctx.env.SLACK_BOT_TOKEN,
        channel: args.channel,
        label: args.label,
        detail: args.detail,
        threadTs: args.threadTs,
        idempotencyKey: args.idempotencyKey,
        ledgerPath: ctx.dbPath,
        config: ctx.config,
        dryRun: args.dryRun,
      }),
  },
  slack_progress_update: {
    name: 'slack_progress_update',
    description: 'Update an existing progress message in place.',
    inputSchema: schemas.slack_progress_update,
    handler: (args, ctx) =>
      updateProgress({
        token: ctx.env.SLACK_BOT_TOKEN,
        channel: args.channel,
        ts: args.ts,
        label: args.label,
        status: args.status,
        detail: args.detail,
        ledgerPath: ctx.dbPath,
        config: ctx.config,
        dryRun: args.dryRun,
      }),
  },
  slack_progress_finish: {
    name: 'slack_progress_finish',
    description: 'Mark an existing progress message done or failed.',
    inputSchema: schemas.slack_progress_finish,
    handler: (args, ctx) =>
      finishProgress({
        token: ctx.env.SLACK_BOT_TOKEN,
        channel: args.channel,
        ts: args.ts,
        label: args.label,
        detail: args.detail,
        ok: args.ok !== false,
        ledgerPath: ctx.dbPath,
        config: ctx.config,
        dryRun: args.dryRun,
      }),
  },
  slack_publish_home: {
    name: 'slack_publish_home',
    description: 'Manually (re)publish the App Home feature-guide tab for a user. The listener does this automatically on app_home_opened.',
    inputSchema: schemas.slack_publish_home,
    handler: (args, ctx) => publishHome({ token: ctx.env.SLACK_BOT_TOKEN, userId: args.userId, dryRun: args.dryRun }),
  },
  slack_agent_session_create: {
    name: 'slack_agent_session_create',
    description: 'Create a local agent-session record for a Slack thread when agentSessions.enabled is true.',
    inputSchema: schemas.slack_agent_session_create,
    handler: (args, ctx) =>
      createAgentSession({
        dbPath: ctx.dbPath,
        config: ctx.config,
        source: args.source || 'manual',
        slackChannel: args.slackChannel,
        slackThreadTs: args.slackThreadTs,
        kind: args.kind,
        metadata: args.metadata || {},
      }),
  },
}
