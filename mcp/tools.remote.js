// Remote-safe tool registry. This file intentionally does not import
// tools.local.js, core/dm.js, core/ask.js, or user-token search paths. The
// remote profile's WHAT is structural; config may only decide WHERE.

import { postToChannel, reply, react, updateMessage, deleteMessage } from '../core/post.js'
import { queryMessages, getThread } from '../core/query.js'
import { resolveUser } from '../core/identity.js'
import { doctor } from '../core/doctor.js'
import { complete } from '../core/ledger.js'
import { schemas } from './schema.js'

function principalLabel(ctx) {
  return ctx.slack?.user_id ? `<@${ctx.slack.user_id}>` : 'unknown Slack user'
}

function withRemoteAttribution(text, ctx) {
  return `${text}\n\n_via Slackbot MCP by ${principalLabel(ctx)}_`
}

function recordRemoteLedgerResult(result, ctx, idempotencyKey) {
  if (result.ok && result.channel && result.ts && ctx.dbPath && idempotencyKey && !result.dryRun && !result.deduped) {
    complete(ctx.dbPath, idempotencyKey, { channel: result.channel, ts: result.ts, remote: true, principal: ctx.slack?.user_id })
  }
  return result
}

export const tools = {
  slack_post: {
    name: 'slack_post',
    description: 'Remote-safe bot post to an allow-listed Slack channel.',
    inputSchema: schemas.slack_post,
    handler: (args, ctx) =>
      postToChannel({
        token: ctx.env.SLACK_BOT_TOKEN,
        channel: args.channel,
        text: withRemoteAttribution(args.text, ctx),
        threadTs: args.threadTs,
        idempotencyKey: args.idempotencyKey,
        ledgerPath: ctx.dbPath,
        config: ctx.config,
        dryRun: args.dryRun,
      }).then(result => recordRemoteLedgerResult(result, ctx, args.idempotencyKey)),
  },
  slack_reply: {
    name: 'slack_reply',
    description: 'Remote-safe bot reply in an allow-listed Slack channel thread.',
    inputSchema: schemas.slack_reply,
    handler: (args, ctx) =>
      reply({
        token: ctx.env.SLACK_BOT_TOKEN,
        channel: args.channel,
        threadTs: args.threadTs,
        text: withRemoteAttribution(args.text, ctx),
        idempotencyKey: args.idempotencyKey,
        ledgerPath: ctx.dbPath,
        config: ctx.config,
        dryRun: args.dryRun,
      }).then(result => recordRemoteLedgerResult(result, ctx, args.idempotencyKey)),
  },
  slack_react: {
    name: 'slack_react',
    description: 'Remote-safe reaction on a message in an allow-listed Slack channel.',
    inputSchema: schemas.slack_react,
    handler: (args, ctx) =>
      react({ token: ctx.env.SLACK_BOT_TOKEN, channel: args.channel, ts: args.ts, emoji: args.emoji, dryRun: args.dryRun }),
  },
  slack_update_message: {
    name: 'slack_update_message',
    description: 'Remote-safe edit of a message posted by this install in an allow-listed Slack channel.',
    inputSchema: schemas.slack_update_message,
    handler: (args, ctx) =>
      updateMessage({
        token: ctx.env.SLACK_BOT_TOKEN,
        channel: args.channel,
        ts: args.ts,
        text: withRemoteAttribution(args.text, ctx),
        ledgerPath: ctx.dbPath,
        config: ctx.config,
        requireLedgerOwnership: true,
        dryRun: args.dryRun,
      }),
  },
  slack_delete_message: {
    name: 'slack_delete_message',
    description: 'Remote-safe delete of a message posted by this install in an allow-listed Slack channel.',
    inputSchema: schemas.slack_delete_message,
    handler: (args, ctx) =>
      deleteMessage({
        token: ctx.env.SLACK_BOT_TOKEN,
        channel: args.channel,
        ts: args.ts,
        ledgerPath: ctx.dbPath,
        requireLedgerOwnership: true,
        dryRun: args.dryRun,
      }),
  },
  slack_query_messages: {
    name: 'slack_query_messages',
    description: 'Read recent history from an allow-listed Slack channel.',
    inputSchema: schemas.slack_query_messages,
    handler: (args, ctx) =>
      queryMessages({ token: ctx.env.SLACK_BOT_TOKEN, channel: args.channel, sinceMinutes: args.sinceMinutes, limit: args.limit }),
  },
  slack_get_thread: {
    name: 'slack_get_thread',
    description: 'Read a thread from an allow-listed Slack channel.',
    inputSchema: schemas.slack_get_thread,
    handler: (args, ctx) => getThread({ token: ctx.env.SLACK_BOT_TOKEN, channel: args.channel, threadTs: args.threadTs }),
  },
  slack_resolve_user: {
    name: 'slack_resolve_user',
    description: 'Resolve a configured handle or name to a Slack user ID.',
    inputSchema: schemas.slack_resolve_user,
    handler: (args, ctx) => resolveUser(args.handle, ctx.config),
  },
  slack_doctor: {
    name: 'slack_doctor',
    description: 'Report remote install health without local token-presence details.',
    inputSchema: schemas.slack_doctor,
    handler: (args, ctx) => doctor({ env: ctx.env, config: ctx.config, profile: 'remote' }).then(report => ({ ok: true, ...report })),
  },
}
