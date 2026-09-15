// The full local tool registry (PLAN §6.3, §5). One tool per core function.
// `slack_post_as_user` is its own tool, separate from `slack_post` — a
// capability that can't be granted separately can't be gated separately
// (§6.2) — and it, `slack_dm` and `slack_search` are exactly what
// mcp/tools.remote.js (built in a later step, §11.2) must NOT import.

import { postToChannel, reply, react, updateMessage, deleteMessage } from '../core/post.js'
import { dm } from '../core/dm.js'
import { queryMessages, getThread } from '../core/query.js'
import { search } from '../core/search.js'
import { resolveUser } from '../core/identity.js'
import { doctor } from '../core/doctor.js'
import { scheduleMessage, deleteScheduledMessage, listScheduledMessages } from '../core/schedule.js'
import { ask } from '../core/ask.js'
import { startProgress, updateProgress, finishProgress } from '../core/progress.js'
import { publishHome } from '../core/home.js'
import { createAgentSession } from '../core/agent-sessions.js'
import { schemas } from './schema.js'

export const tools = {
  slack_post: {
    name: 'slack_post',
    description: 'Post a message to a Slack channel as the bot. "@handle" in text is resolved to a real Slack mention against slack-config.json.',
    inputSchema: schemas.slack_post,
    handler: (args, ctx) =>
      postToChannel({
        token: ctx.env.SLACK_BOT_TOKEN,
        channel: args.channel,
        text: args.text,
        threadTs: args.threadTs,
        idempotencyKey: args.idempotencyKey,
        ledgerPath: ctx.dbPath,
        config: ctx.config,
        dryRun: args.dryRun,
      }),
  },
  slack_reply: {
    name: 'slack_reply',
    description: 'Reply in a Slack thread as the bot. "@handle" in text is resolved to a real Slack mention against slack-config.json.',
    inputSchema: schemas.slack_reply,
    handler: (args, ctx) =>
      reply({
        token: ctx.env.SLACK_BOT_TOKEN,
        channel: args.channel,
        threadTs: args.threadTs,
        text: args.text,
        idempotencyKey: args.idempotencyKey,
        ledgerPath: ctx.dbPath,
        config: ctx.config,
        dryRun: args.dryRun,
      }),
  },
  slack_react: {
    name: 'slack_react',
    description: 'Add an emoji reaction to a message.',
    inputSchema: schemas.slack_react,
    handler: (args, ctx) =>
      react({ token: ctx.env.SLACK_BOT_TOKEN, channel: args.channel, ts: args.ts, emoji: args.emoji, dryRun: args.dryRun }),
  },
  slack_update_message: {
    name: 'slack_update_message',
    description: 'Edit a message previously posted by this install.',
    inputSchema: schemas.slack_update_message,
    handler: (args, ctx) =>
      updateMessage({
        token: ctx.env.SLACK_BOT_TOKEN,
        channel: args.channel,
        ts: args.ts,
        text: args.text,
        ledgerPath: ctx.dbPath,
        config: ctx.config,
        dryRun: args.dryRun,
      }),
  },
  slack_delete_message: {
    name: 'slack_delete_message',
    description: 'Delete a message previously posted by this install.',
    inputSchema: schemas.slack_delete_message,
    handler: (args, ctx) =>
      deleteMessage({ token: ctx.env.SLACK_BOT_TOKEN, channel: args.channel, ts: args.ts, ledgerPath: ctx.dbPath, dryRun: args.dryRun }),
  },
  slack_dm: {
    name: 'slack_dm',
    description: 'Send a DM to a user as the bot. Local only.',
    inputSchema: schemas.slack_dm,
    handler: (args, ctx) =>
      dm({ botToken: ctx.env.SLACK_BOT_TOKEN, userId: args.userId, text: args.text, config: ctx.config, dbPath: ctx.dbPath, dryRun: args.dryRun }),
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
  slack_resolve_user: {
    name: 'slack_resolve_user',
    description: 'Resolve a configured handle or name to a Slack user ID.',
    inputSchema: schemas.slack_resolve_user,
    handler: (args, ctx) => resolveUser(args.handle, ctx.config),
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
