// Pins and channel bookmarks (D72). Both are visible to everyone in the
// conversation, so — like a post — they act as the authorized human by
// default (user token), never silently as the bot.
//
// pins.add / pins.remove / pins.list and bookmarks.add / bookmarks.list /
// bookmarks.edit / bookmarks.remove. Same conventions as core/post.js.

import { callSlack } from './slack.js'

export async function pinMessage({ token, channel, ts, dryRun, slackCall = callSlack }) {
  if (!channel || !ts) return { ok: false, error: 'channel-and-ts-required', retryable: false }
  const body = { channel, timestamp: ts }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'pins.add', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('pins.add', token, body)
}

export async function unpinMessage({ token, channel, ts, dryRun, slackCall = callSlack }) {
  if (!channel || !ts) return { ok: false, error: 'channel-and-ts-required', retryable: false }
  const body = { channel, timestamp: ts }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'pins.remove', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('pins.remove', token, body)
}

export async function listPins({ token, channel, slackCall = callSlack }) {
  if (!channel) return { ok: false, error: 'channel-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('pins.list', token, { channel })
}

function isHttpUrl(value) {
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

export async function addBookmark({ token, channel, title, link, emoji, dryRun, slackCall = callSlack }) {
  if (!channel) return { ok: false, error: 'channel-required', retryable: false }
  if (!title) return { ok: false, error: 'title-required', retryable: false }
  if (!link || !isHttpUrl(link)) return { ok: false, error: 'valid-http-link-required', retryable: false }
  const body = { channel_id: channel, title, type: 'link', link, ...(emoji && { emoji }) }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'bookmarks.add', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('bookmarks.add', token, body)
}

export async function listBookmarks({ token, channel, slackCall = callSlack }) {
  if (!channel) return { ok: false, error: 'channel-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('bookmarks.list', token, { channel_id: channel })
}

export async function editBookmark({ token, channel, bookmarkId, title, link, emoji, dryRun, slackCall = callSlack }) {
  if (!channel || !bookmarkId) return { ok: false, error: 'channel-and-bookmarkId-required', retryable: false }
  if (title === undefined && link === undefined && emoji === undefined) return { ok: false, error: 'title-link-or-emoji-required', retryable: false }
  if (link !== undefined && !isHttpUrl(link)) return { ok: false, error: 'valid-http-link-required', retryable: false }
  const body = {
    channel_id: channel,
    bookmark_id: bookmarkId,
    ...(title !== undefined && { title }),
    ...(link !== undefined && { link }),
    ...(emoji !== undefined && { emoji }),
  }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'bookmarks.edit', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('bookmarks.edit', token, body)
}

export async function removeBookmark({ token, channel, bookmarkId, dryRun, slackCall = callSlack }) {
  if (!channel || !bookmarkId) return { ok: false, error: 'channel-and-bookmarkId-required', retryable: false }
  const body = { channel_id: channel, bookmark_id: bookmarkId }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'bookmarks.remove', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('bookmarks.remove', token, body)
}
