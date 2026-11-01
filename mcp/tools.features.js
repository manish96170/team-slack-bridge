// The D72 feature tools: message-link resolution, call cards, huddle status,
// canvases, pins, bookmarks, reminders, user-group lookup, file reading, and
// the authorized human's status/presence/DND. Merged into the local registry
// by mcp/tools.local.js. Local-only: none of these are in tools.remote.js,
// because each acts as — or reads on behalf of — the locally authorized
// human, and the hosted profile has no user tokens (D20).
//
// Identity rule, same as the rest of the registry: writes use the human's
// token (SLACK_USER_TOKEN) and never silently fall back to the bot. The
// read-only tools (huddle status, user groups, files) take an explicit
// `tokenSource`, echoed back, defaulting to the human.

import { dirname, join } from 'node:path'
import { parseSlackLink } from '../core/links.js'
import { startCall, updateCall, endCall, getCallInfo } from '../core/calls.js'
import { getHuddleStatus } from '../core/huddle.js'
import { createCanvas, editCanvas, shareCanvas, lookupCanvasSections, deleteCanvas } from '../core/canvases.js'
import { pinMessage, unpinMessage, listPins, addBookmark, listBookmarks, editBookmark, removeBookmark } from '../core/pins.js'
import { addReminder, listReminders, completeReminder, deleteReminder } from '../core/reminders.js'
import { lookupUserGroup } from '../core/usergroups.js'
import { getFileInfo, listFiles, readFile } from '../core/files.js'
import { setStatus, setPresence, manageDnd } from '../core/status.js'
import { getReactions, listReactions } from '../core/reactions.js'
import { schemas } from './schema.js'

const missing = field => ({ ok: false, error: `${field}-required`, retryable: false })
const badAction = actions => ({ ok: false, error: `action-must-be-one-of-${actions.join('|')}`, retryable: false })

function humanToken(args, ctx) {
  const token = ctx.env.SLACK_USER_TOKEN
  if (!token && !args.dryRun) return { error: { ok: false, error: 'user-token-required', retryable: false } }
  return { token }
}

function readToken(args, ctx) {
  const tokenSource = args.tokenSource === 'bot' ? 'bot' : 'user'
  return { tokenSource, token: tokenSource === 'bot' ? ctx.env.SLACK_BOT_TOKEN : ctx.env.SLACK_USER_TOKEN }
}

// Wraps a handler that only needs the human's token.
const asHuman = run => (args, ctx) => {
  const { token, error } = humanToken(args, ctx)
  return error || run(args, ctx, token)
}

export const featureTools = {
  slack_resolve_link: {
    name: 'slack_resolve_link',
    description:
      'Parse a pasted Slack message permalink into its conversation ID, message timestamp and thread root — offline, no Slack call. Returns the link\'s workspace domain so you can confirm the right account/workspace before acting. Most message tools also accept a `link` argument directly; use this when you only need the parts.',
    inputSchema: schemas.slack_resolve_link,
    handler: args => parseSlackLink(args.link),
  },

  slack_call: {
    name: 'slack_call',
    description:
      'Slack Calls API, as the locally authorized human (user token, calls:write; info needs calls:read). Slack does not host calls: action "start" registers a call hosted elsewhere and posts it as a native call card (participants, Join button, duration) — pass joinUrl for a Meet/Zoom/Teams link you already have, or omit it to get a fresh Jitsi room. Huddles themselves cannot be started or joined through any Slack API. "update" changes title/joinUrl, "end" marks it finished, "info" reads it back. The card is visible to everyone in the conversation, so only start one when the human asked for it.',
    inputSchema: schemas.slack_call,
    handler: asHuman(async (args, ctx, token) => {
      switch (args.action) {
        case 'start':
          return startCall({
            token, channel: args.channel, threadTs: args.threadTs, title: args.title, joinUrl: args.joinUrl,
            jitsiBaseUrl: ctx.config?.calls?.jitsiBaseUrl, userIds: args.userIds, post: args.post !== false, dryRun: args.dryRun,
          })
        case 'update':
          return updateCall({ token, callId: args.callId, title: args.title, joinUrl: args.joinUrl, dryRun: args.dryRun })
        case 'end':
          return endCall({ token, callId: args.callId, durationSeconds: args.durationSeconds, dryRun: args.dryRun })
        case 'info':
          return getCallInfo({ token, callId: args.callId })
        default:
          return badAction(['start', 'update', 'end', 'info'])
      }
    }),
  },

  slack_huddle_status: {
    name: 'slack_huddle_status',
    description:
      'Who is in a huddle right now: reads each user\'s huddle_state (users.info, users:read). Pass userIds and/or a channel whose members to check (capped by limit; truncation is reported). This only reports presence in a huddle — Slack offers no API to join, record or read the audio of one.',
    inputSchema: schemas.slack_huddle_status,
    handler: async (args, ctx) => {
      const { tokenSource, token } = readToken(args, ctx)
      const result = await getHuddleStatus({ token, userIds: args.userIds, channel: args.channel, limit: args.limit })
      return { ...result, tokenSource }
    },
  },

  slack_canvas: {
    name: 'slack_canvas',
    description:
      'Slack canvases, as the locally authorized human (user token; canvases:write, canvases:read, files:read for "read"). create: a standalone canvas (title + markdown) or, with channelId, that conversation\'s channel canvas. edit: insert/replace/delete content by operation (+ sectionId; find IDs with "sections"). share: grant read/write access to channels or users — this exposes the canvas to those people, so only on request. read: the canvas as text. delete: permanent for everyone it is shared with, so it requires confirm:true after the human approved deleting that exact canvas.',
    inputSchema: schemas.slack_canvas,
    handler: asHuman(async (args, ctx, token) => {
      switch (args.action) {
        case 'create':
          return createCanvas({ token, title: args.title, markdown: args.markdown, channelId: args.channelId, dryRun: args.dryRun })
        case 'edit':
          return editCanvas({ token, canvasId: args.canvasId, operation: args.operation, markdown: args.markdown, sectionId: args.sectionId, dryRun: args.dryRun })
        case 'share':
          return shareCanvas({ token, canvasId: args.canvasId, accessLevel: args.accessLevel, channelIds: args.channelIds, userIds: args.userIds, dryRun: args.dryRun })
        case 'sections':
          return lookupCanvasSections({ token, canvasId: args.canvasId, containsText: args.containsText, sectionTypes: args.sectionTypes })
        case 'read':
          return args.canvasId ? readFile({ token, fileId: args.canvasId, maxChars: args.maxChars }) : missing('canvasId')
        case 'delete':
          return deleteCanvas({ token, canvasId: args.canvasId, confirm: args.confirm, dryRun: args.dryRun })
        default:
          return badAction(['create', 'edit', 'share', 'sections', 'read', 'delete'])
      }
    }),
  },

  slack_pin: {
    name: 'slack_pin',
    description:
      'Pin, unpin or list pinned messages in a conversation, as the locally authorized human (user token; pins:write, pins:read). Pins are visible to everyone in the conversation, so only add/remove on request. Accepts a message `link`.',
    inputSchema: schemas.slack_pin,
    handler: asHuman((args, ctx, token) => {
      switch (args.action) {
        case 'add':
          return pinMessage({ token, channel: args.channel, ts: args.ts, dryRun: args.dryRun })
        case 'remove':
          return unpinMessage({ token, channel: args.channel, ts: args.ts, dryRun: args.dryRun })
        case 'list':
          return listPins({ token, channel: args.channel })
        default:
          return badAction(['add', 'remove', 'list'])
      }
    }),
  },

  slack_bookmark: {
    name: 'slack_bookmark',
    description:
      'Add, list, edit or remove link bookmarks in a conversation\'s bookmark bar, as the locally authorized human (user token; bookmarks:write, bookmarks:read). Visible to everyone in the conversation, so only change them on request.',
    inputSchema: schemas.slack_bookmark,
    handler: asHuman((args, ctx, token) => {
      switch (args.action) {
        case 'add':
          return addBookmark({ token, channel: args.channel, title: args.title, link: args.url, emoji: args.emoji, dryRun: args.dryRun })
        case 'list':
          return listBookmarks({ token, channel: args.channel })
        case 'edit':
          return editBookmark({ token, channel: args.channel, bookmarkId: args.bookmarkId, title: args.title, link: args.url, emoji: args.emoji, dryRun: args.dryRun })
        case 'remove':
          return removeBookmark({ token, channel: args.channel, bookmarkId: args.bookmarkId, dryRun: args.dryRun })
        default:
          return badAction(['add', 'list', 'edit', 'remove'])
      }
    }),
  },

  slack_reminder: {
    name: 'slack_reminder',
    description:
      'The locally authorized human\'s Slack reminders (user token only — Slack bots cannot own reminders; reminders:write, reminders:read). add: text + time (ISO 8601, Unix timestamp, seconds from now, or natural language). A reminder for ANOTHER user (userId) shows up in their Slackbot DM under your name, so it requires confirm:true after the human approved that exact reminder for that person. list / complete / delete act on your own reminders.',
    inputSchema: schemas.slack_reminder,
    handler: asHuman((args, ctx, token) => {
      switch (args.action) {
        case 'add':
          return addReminder({ token, text: args.text, time: args.time, userId: args.userId, confirm: args.confirm, dryRun: args.dryRun })
        case 'list':
          return listReminders({ token })
        case 'complete':
          return completeReminder({ token, reminderId: args.reminderId, dryRun: args.dryRun })
        case 'delete':
          return deleteReminder({ token, reminderId: args.reminderId, dryRun: args.dryRun })
        default:
          return badAction(['add', 'list', 'complete', 'delete'])
      }
    }),
  },

  slack_usergroup_lookup: {
    name: 'slack_usergroup_lookup',
    description:
      'Find a Slack user group (@reviewers, @oncall) by handle, name or ID and get its mention string (<!subteam^ID>) for use in a message, optionally with member IDs (usergroups:read). More than one exact match refuses with ambiguous-usergroup rather than guessing. Read-only; the resolved tokenSource is echoed back.',
    inputSchema: schemas.slack_usergroup_lookup,
    handler: async (args, ctx) => {
      const { tokenSource, token } = readToken(args, ctx)
      return lookupUserGroup({ token, tokenSource, query: args.query, includeMembers: !!args.includeMembers, includeDisabled: !!args.includeDisabled })
    },
  },

  slack_file: {
    name: 'slack_file',
    description:
      'Read files other people posted (files:read). A message\'s JSON lists files[].id; action "info" gives metadata, "list" recent files (optionally per channel/user), and "read" the content — text, code and canvases come back inline (truncated to maxChars), anything else (images, PDFs) is saved under the install\'s downloads folder and returned as a local path you can open. Downloads only from slack.com hosts and never follows redirects with the token. Read-only; the resolved tokenSource is echoed back.',
    inputSchema: schemas.slack_file,
    handler: async (args, ctx) => {
      const { tokenSource, token } = readToken(args, ctx)
      let result
      switch (args.action) {
        case 'info':
          result = await getFileInfo({ token, fileId: args.fileId })
          break
        case 'list':
          result = await listFiles({ token, channel: args.channel, userId: args.userId, types: args.types, count: args.count })
          break
        case 'read':
          result = await readFile({ token, fileId: args.fileId, maxChars: args.maxChars, destDir: ctx.dbPath ? join(dirname(ctx.dbPath), 'downloads') : undefined })
          break
        default:
          return badAction(['info', 'list', 'read'])
      }
      return { ...result, tokenSource }
    },
  },

  slack_reactions: {
    name: 'slack_reactions',
    description:
      'Read reactions (reactions:read, user or bot token). action "get": who reacted with which emoji on one message (channel + ts, or a message `link`); optionally only one emoji. action "list": the messages a user has reacted to (default: the token\'s own user), newest first, with a pagination cursor. Read-only; the resolved tokenSource is echoed back (default the locally authorized human; "bot" is explicit). The bot can only see messages in conversations it is a member of. To ADD or REMOVE a reaction use slack_react / slack_unreact.',
    inputSchema: schemas.slack_reactions,
    handler: async (args, ctx) => {
      const { tokenSource, token } = readToken(args, ctx)
      let result
      switch (args.action) {
        case 'get':
          result = await getReactions({ token, channel: args.channel, ts: args.ts, emoji: args.emoji })
          break
        case 'list':
          result = await listReactions({ token, userId: args.userId, count: args.count, cursor: args.cursor, emoji: args.emoji })
          break
        default:
          return badAction(['get', 'list'])
      }
      return { ...result, tokenSource }
    },
  },

  slack_set_status: {
    name: 'slack_set_status',
    description:
      'Set or clear the locally authorized human\'s Slack status (text, emoji, optional auto-expiry), user token with users.profile:write. This changes how they appear to everyone, so only on request.',
    inputSchema: schemas.slack_set_status,
    handler: asHuman((args, ctx, token) =>
      setStatus({ token, text: args.text, emoji: args.emoji, expiresInMinutes: args.expiresInMinutes, clear: args.clear, dryRun: args.dryRun })),
  },

  slack_set_presence: {
    name: 'slack_set_presence',
    description: 'Force the locally authorized human\'s presence to "away", or return to "auto" (user token with users:write). Only on request.',
    inputSchema: schemas.slack_set_presence,
    handler: asHuman((args, ctx, token) => setPresence({ token, presence: args.presence, dryRun: args.dryRun })),
  },

  slack_dnd: {
    name: 'slack_dnd',
    description: 'Do Not Disturb for the locally authorized human: snooze notifications for N minutes, end the snooze, or read the current state (user token with dnd:write / dnd:read). Only snooze/end on request.',
    inputSchema: schemas.slack_dnd,
    handler: asHuman((args, ctx, token) => manageDnd({ token, action: args.action, minutes: args.minutes, userId: args.userId, dryRun: args.dryRun })),
  },
}
