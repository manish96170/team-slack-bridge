// Bot-send tracking (PLAN D48). When a `viaBot:true` send actually goes
// out, and this install's sender is identified (core/sender.js's
// `isAuthorizedSender`), the sender gets their own private, threaded record
// of it: a DM "You have sent <X> via Bot" as the thread parent, with the
// real message content (and nothing else) as a single reply underneath.
// That keeps a sender's own DM history with the bot to one line per send,
// full content one click away — and gives an edit/delete on the original
// a place to propagate to.
//
// Deliberately best-effort: a tracking failure never fails the primary
// send/edit/delete it's attached to (the real message already went out,
// or already changed) — see the `.catch` wrapping in mcp/tools.local.js.
// Deliberately opt-out, not opt-in: `botSendTracking.enabled` (default
// true, core/identity.js) turns the whole thing off for installs that
// don't want a tracking copy at all.

import { dm } from './dm.js'
import { reply, updateMessage, deleteMessage } from './post.js'
import { getDb } from './db.js'

export function isTrackingEnabled(config) {
  return config?.botSendTracking?.enabled !== false
}

export function recordBotSendTracking({ dbPath, senderId, originalChannel, originalTs, trackingChannel, trackingParentTs, trackingReplyTs, anonymous }) {
  if (!dbPath) return
  getDb(dbPath)
    .prepare(
      `INSERT INTO bot_send_tracking
       (created_at, sender_user_id, original_channel, original_ts, tracking_channel, tracking_parent_ts, tracking_reply_ts, anonymous)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(original_channel, original_ts) DO UPDATE SET tracking_reply_ts = excluded.tracking_reply_ts`
    )
    .run(new Date().toISOString(), senderId, originalChannel, originalTs, trackingChannel, trackingParentTs, trackingReplyTs || null, anonymous ? 1 : 0)
}

export function findBotSendTracking({ dbPath, channel, ts }) {
  if (!dbPath || !channel || !ts) return null
  return getDb(dbPath).prepare(`SELECT * FROM bot_send_tracking WHERE original_channel = ? AND original_ts = ?`).get(channel, ts) || null
}

export function removeBotSendTracking({ dbPath, channel, ts }) {
  if (!dbPath || !channel || !ts) return
  getDb(dbPath).prepare(`DELETE FROM bot_send_tracking WHERE original_channel = ? AND original_ts = ?`).run(channel, ts)
}

function targetLabel({ kind, channel, targetUserId }) {
  return kind === 'dm' ? `a DM to <@${targetUserId}>` : `a bot message in ${channel}`
}

// Posts the "You have sent ... via Bot" parent DM, then the actual sent
// text as a single threaded reply underneath it, and records the mapping
// so a later edit/delete on the original can find its way back here.
export async function echoBotSendToSender({ botToken, dbPath, config, senderId, kind, channel, targetUserId, text, originalChannel, originalTs, anonymous, dryRun }) {
  if (dryRun) return { ok: true, dryRun: true, skipped: 'dry-run' }
  if (!botToken || !senderId) return { ok: false, error: 'tracking-skipped-missing-token-or-sender', retryable: false }

  const header = `You have sent ${targetLabel({ kind, channel, targetUserId })} via Bot`
  const parent = await dm({ botToken, userId: senderId, text: header, config, dbPath })
  if (!parent.ok) return parent

  const threadReply = await reply({ token: botToken, channel: parent.channel, threadTs: parent.ts, text, config })

  recordBotSendTracking({
    dbPath,
    senderId,
    originalChannel,
    originalTs,
    trackingChannel: parent.channel,
    trackingParentTs: parent.ts,
    trackingReplyTs: threadReply.ok ? threadReply.ts : null,
    anonymous,
  })

  return { ok: true, trackingChannel: parent.channel, trackingParentTs: parent.ts, trackingReplyTs: threadReply.ts, threadReplyOk: threadReply.ok }
}

// Called after a successful bot-token slack_update_message — edits ONLY
// the threaded reply's content, leaving the "You have sent..." parent
// label alone, since that label describes the send, not its current text.
export async function propagateUpdateToTracking({ botToken, dbPath, config, channel, ts, text }) {
  const tracking = findBotSendTracking({ dbPath, channel, ts })
  if (!tracking?.tracking_reply_ts) return { ok: true, skipped: 'no-tracking-copy' }
  return updateMessage({ token: botToken, channel: tracking.tracking_channel, ts: tracking.tracking_reply_ts, text, config })
}

// Called after a successful bot-token slack_delete_message — deletes the
// WHOLE tracking DM (parent label + threaded reply), not just the reply,
// since there is no reason to keep "You have sent..." around once the
// message it refers to no longer exists. Then drops the tracking row.
export async function propagateDeleteToTracking({ botToken, dbPath, channel, ts }) {
  const tracking = findBotSendTracking({ dbPath, channel, ts })
  if (!tracking) return { ok: true, skipped: 'no-tracking-copy' }

  if (tracking.tracking_reply_ts) {
    await deleteMessage({ token: botToken, channel: tracking.tracking_channel, ts: tracking.tracking_reply_ts }).catch(() => {})
  }
  const parentResult = await deleteMessage({ token: botToken, channel: tracking.tracking_channel, ts: tracking.tracking_parent_ts }).catch(err => ({ ok: false, error: err.message }))
  removeBotSendTracking({ dbPath, channel, ts })
  return parentResult
}
