// Huddle awareness (D72). There is no Slack API to start, join, record or end
// a huddle — and none to read its audio. What Slack does expose is the
// presence of one: every user profile carries `huddle_state`
// ('in_a_huddle' | 'available_for_huddle' | 'default_unset'), and the
// `user_huddle_changed` event fires when it flips. This module reads and
// interprets that; it never claims more than Slack tells it.

import { callSlack } from './slack.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const CONCURRENCY = 5

export function huddleFromUser(user) {
  const profile = user?.profile || {}
  const state = profile.huddle_state || 'default_unset'
  const expiry = Number(profile.huddle_state_expiration_ts)
  return {
    userId: user?.id,
    displayName: profile.display_name || profile.real_name || user?.real_name || user?.name || undefined,
    inHuddle: state === 'in_a_huddle',
    huddleState: state,
    ...(profile.huddle_state_channel_id && { channelId: profile.huddle_state_channel_id }),
    ...(profile.huddle_state_call_id && { callId: profile.huddle_state_call_id }),
    ...(Number.isFinite(expiry) && expiry > 0 && { expiresAt: new Date(expiry * 1000).toISOString() }),
  }
}

// Pure transition detector for the listener: compares the last state we saw
// for a user with the state in a user_huddle_changed payload.
export function describeHuddleChange(previous, user) {
  const current = huddleFromUser(user)
  const wasIn = previous?.inHuddle === true
  let transition = 'unchanged'
  if (!wasIn && current.inHuddle) transition = 'started'
  else if (wasIn && !current.inHuddle) transition = 'ended'
  return { transition, current, previous }
}

async function mapLimited(items, fn) {
  const results = []
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    results.push(...(await Promise.all(items.slice(i, i + CONCURRENCY).map(fn))))
  }
  return results
}

export async function getHuddleStatus({ token, userIds, channel, limit = DEFAULT_LIMIT, slackCall = callSlack }) {
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  const ids = [...new Set((userIds || []).filter(Boolean))]
  if (!ids.length && !channel) return { ok: false, error: 'userIds-or-channel-required', retryable: false }

  const cap = Math.min(Math.max(Math.floor(Number(limit)) || DEFAULT_LIMIT, 1), MAX_LIMIT)
  let truncated = false
  if (channel) {
    const members = await slackCall('conversations.members', token, { channel, limit: String(MAX_LIMIT) })
    if (!members.ok) return members
    for (const id of members.members || []) if (!ids.includes(id)) ids.push(id)
    truncated = !!members.response_metadata?.next_cursor
  }
  if (ids.length > cap) truncated = true
  const selected = ids.slice(0, cap)

  const users = await mapLimited(selected, async userId => {
    const info = await slackCall('users.info', token, { user: userId })
    if (!info.ok) return { userId, error: info.error, retryable: info.retryable }
    return huddleFromUser(info.user)
  })

  return {
    ok: true,
    checked: users.length,
    truncated,
    inHuddle: users.filter(user => user.inHuddle),
    users,
  }
}

// ---------------------------------------------------------------------------
// Listener side: user_huddle_changed (Socket Mode). Opt-in via
// config.huddleWatch — off by default, so an install that never asked for it
// never starts tracking anyone's huddles. Only the watched users (default:
// the owner) are ever considered. "Emit, do not act" (PLAN §4.2): the change
// is surfaced to the caller's onClassified queue; the one thing done here is
// the optional recap prompt, a single bot DM to the owner themselves.
// ---------------------------------------------------------------------------

export function watchedHuddleUserIds(config) {
  const watch = config?.huddleWatch
  if (!watch?.enabled) return []
  if (watch.userIds?.length) return watch.userIds
  return config?.owner?.slackUserId ? [config.owner.slackUserId] : []
}

export function recapPromptText(previous) {
  const where = previous?.channelId ? ` in <#${previous.channelId}>` : ''
  return `Your huddle${where} just ended. Slack doesn't give me its audio or a transcript — paste your notes (or Slack's AI huddle notes) here and I can turn them into a recap and action items.`
}

export async function handleHuddleChange({ event, config, states, onClassified, sendDm }) {
  const user = event?.user
  if (!user?.id || !watchedHuddleUserIds(config).includes(user.id)) return { handled: false, reason: 'not-watched' }

  const { transition, current, previous } = describeHuddleChange(states.get(user.id), user)
  states.set(user.id, current)
  if (transition === 'unchanged') return { handled: false, reason: 'unchanged', transition }

  const kind = transition === 'started' ? 'huddle-started' : 'huddle-ended'
  const payload = { kind, huddle: transition === 'ended' ? { ...current, channelId: previous?.channelId, callId: previous?.callId } : current }
  await onClassified(payload)

  const ownerId = config?.owner?.slackUserId
  if (transition === 'ended' && config?.huddleWatch?.promptRecap && ownerId && sendDm) {
    await sendDm({ userId: ownerId, text: recapPromptText(previous) })
  }
  return { handled: true, transition, kind }
}
