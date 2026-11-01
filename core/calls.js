// Slack Calls API (D72). Slack does NOT host calls: calls.add only tells
// Slack about a call that lives elsewhere (Jitsi, Meet, Zoom, …) so it shows
// up as a native call card — participant list, Join button, duration — in
// the conversation. Huddles cannot be started or joined through any API;
// this is the closest supported equivalent.
//
// User-token only (the call is registered and posted as the authorized
// human). Same shape as every other core module: token as a parameter,
// structured { ok:false, error, retryable } failures, dry-run support, and an
// injectable `slackCall` so tests never touch the network.

import { randomBytes, randomUUID } from 'node:crypto'
import { callSlack } from './slack.js'

export const DEFAULT_JITSI_BASE_URL = 'https://meet.jit.si'

function slugify(value) {
  return String(value || 'call')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'call'
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

// An explicit joinUrl (a Meet/Zoom/Teams link the human already has) always
// wins. Without one a unique Jitsi room is generated, which needs no account
// or API key to create — the room exists as soon as someone opens the URL.
export function resolveJoinUrl({ joinUrl, title, jitsiBaseUrl = DEFAULT_JITSI_BASE_URL }) {
  if (joinUrl) {
    if (!isHttpsUrl(joinUrl)) return { ok: false, error: 'joinUrl-must-be-https', retryable: false }
    return { ok: true, joinUrl, provider: 'url' }
  }
  if (!isHttpsUrl(jitsiBaseUrl)) return { ok: false, error: 'invalid-jitsiBaseUrl', retryable: false }
  const room = `${slugify(title)}-${randomBytes(4).toString('hex')}`
  return { ok: true, joinUrl: `${jitsiBaseUrl.replace(/\/+$/, '')}/${room}`, provider: 'jitsi' }
}

function slackUsers(userIds) {
  return (userIds || []).filter(Boolean).map(id => ({ slack_id: id }))
}

export async function startCall({
  token, channel, threadTs, title, joinUrl, jitsiBaseUrl, userIds, post = true, dryRun, slackCall = callSlack,
}) {
  if (!channel && post) return { ok: false, error: 'channel-required', retryable: false }
  const callTitle = (title || '').trim() || 'Call'
  const resolved = resolveJoinUrl({ joinUrl, title: callTitle, jitsiBaseUrl })
  if (!resolved.ok) return resolved

  const users = slackUsers(userIds)
  const addBody = {
    external_unique_id: randomUUID(),
    join_url: resolved.joinUrl,
    title: callTitle,
    ...(users.length && { users: JSON.stringify(users) }),
  }
  const postBody = post
    ? { channel, thread_ts: threadTs, text: `📞 ${callTitle}: ${resolved.joinUrl}`, blocks: [{ type: 'call', call_id: '<call_id from calls.add>' }] }
    : undefined

  if (dryRun) {
    return { ok: true, dryRun: true, provider: resolved.provider, joinUrl: resolved.joinUrl, request: { add: { method: 'calls.add', body: addBody }, ...(post && { post: { method: 'chat.postMessage', body: postBody } }) } }
  }
  if (!token) return { ok: false, error: 'no-token', retryable: false }

  const added = await slackCall('calls.add', token, addBody)
  if (!added.ok) return added
  const callId = added.call?.id
  const base = { provider: resolved.provider, joinUrl: resolved.joinUrl, callId, call: added.call }
  if (!post) return { ok: true, ...base }

  const posted = await slackCall('chat.postMessage', token, { ...postBody, blocks: [{ type: 'call', call_id: callId }] })
  // The call is registered with Slack even if posting failed (e.g. the user
  // is not in the channel). Return the id so the caller can retry the post or
  // end the call instead of leaving an orphan.
  if (!posted.ok) return { ok: false, error: `call-registered-but-post-failed: ${posted.error}`, retryable: posted.retryable, callId, joinUrl: resolved.joinUrl }
  return { ok: true, ...base, channel: posted.channel, ts: posted.ts }
}

export async function updateCall({ token, callId, title, joinUrl, dryRun, slackCall = callSlack }) {
  if (!callId) return { ok: false, error: 'callId-required', retryable: false }
  if (title === undefined && joinUrl === undefined) return { ok: false, error: 'title-or-joinUrl-required', retryable: false }
  if (joinUrl !== undefined && !isHttpsUrl(joinUrl)) return { ok: false, error: 'joinUrl-must-be-https', retryable: false }
  const body = { id: callId, ...(title !== undefined && { title }), ...(joinUrl !== undefined && { join_url: joinUrl }) }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'calls.update', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('calls.update', token, body)
}

export async function endCall({ token, callId, durationSeconds, dryRun, slackCall = callSlack }) {
  if (!callId) return { ok: false, error: 'callId-required', retryable: false }
  const body = { id: callId, ...(Number.isFinite(durationSeconds) && durationSeconds >= 0 && { duration: Math.floor(durationSeconds) }) }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'calls.end', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('calls.end', token, body)
}

export async function getCallInfo({ token, callId, slackCall = callSlack }) {
  if (!callId) return { ok: false, error: 'callId-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('calls.info', token, { id: callId })
}
