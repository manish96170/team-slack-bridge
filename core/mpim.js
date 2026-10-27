// Existing group-DM (MPIM) messaging, local-only. An MPIM belongs to the
// human user who can see it, not the shared bot: this module always sends
// with SLACK_USER_TOKEN and never creates/opens a conversation implicitly.
// A missing exact group returns a distinct "ask first" result; the skill or
// caller decides whether to ask the human about creation in a later pass.

import { createHash } from 'node:crypto'
import { getDb } from './db.js'
import { callSlack } from './slack.js'
import { lookupUser, MAX_PAGES } from './directory.js'

const DIRECTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000

function normalize(value) {
  return (value || '').trim().replace(/^@/, '').toLowerCase()
}

function tokenIdentity(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 12)
}

function memberKey(ids) {
  return [...new Set(ids)].sort().join(':')
}

function isFresh(timestamp) {
  return timestamp && Date.now() - new Date(timestamp).getTime() < DIRECTORY_TTL_MS
}

function cachedPerson({ dbPath, workspaceId, query }) {
  if (!dbPath) return null
  const db = getDb(dbPath)
  const state = db.prepare('SELECT refreshed_at FROM directory_index_state WHERE workspace_id = ?').get(workspaceId)
  // A partial set of opportunistically-found people cannot safely prove a
  // name is unique: it could hide the exact ambiguous-user collision that
  // core/directory.js correctly refuses live. Only use the disk index after
  // a complete, fresh users.list snapshot has populated it.
  if (!state || !isFresh(state.refreshed_at)) return null
  const needle = normalize(query)
  const rows = db
    .prepare(
      `SELECT user_id AS id, handle, display_name AS displayName, real_name AS realName, refreshed_at
       FROM directory_people
       WHERE workspace_id = ?
         AND (normalized_handle = ? OR normalized_display_name = ? OR normalized_real_name = ?)`
    )
    .all(workspaceId, needle, needle, needle)
  if (rows.length === 1) return { user: rows[0] }
  if (rows.length > 1) return { ambiguous: true, matches: rows.map(({ id, displayName, handle }) => ({ id, displayName, handle })) }
  return null
}

function cacheDirectoryMembers({ dbPath, workspaceId, members, truncated }) {
  if (!dbPath || truncated) return
  const db = getDb(dbPath)
  const now = new Date().toISOString()
  const eligible = (members || []).filter(member => member && !member.deleted && !member.is_bot && member.id !== 'USLACKBOT')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('DELETE FROM directory_people WHERE workspace_id = ?').run(workspaceId)
    const insert = db.prepare(
      `INSERT INTO directory_people (
         workspace_id, user_id, handle, display_name, real_name,
         normalized_handle, normalized_display_name, normalized_real_name, refreshed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, user_id) DO UPDATE SET
         handle = excluded.handle, display_name = excluded.display_name,
         real_name = excluded.real_name, normalized_handle = excluded.normalized_handle,
         normalized_display_name = excluded.normalized_display_name,
         normalized_real_name = excluded.normalized_real_name, refreshed_at = excluded.refreshed_at`
    )
    for (const member of eligible) {
      const handle = member.name || null
      const displayName = member.profile?.display_name || member.profile?.real_name || member.real_name || member.name || null
      const realName = member.real_name || member.profile?.real_name || null
      insert.run(workspaceId, member.id, handle, displayName, realName, normalize(handle), normalize(displayName), normalize(realName), now)
    }
    db.prepare(
      `INSERT INTO directory_index_state (workspace_id, refreshed_at) VALUES (?, ?)
       ON CONFLICT(workspace_id) DO UPDATE SET refreshed_at = excluded.refreshed_at`
    ).run(workspaceId, now)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

async function resolvePeople({ peopleNames, userToken, workspaceId, dbPath, slackCall, dryRun }) {
  const users = []
  for (const query of peopleNames) {
    const cached = dryRun ? null : cachedPerson({ dbPath, workspaceId, query })
    if (cached?.ambiguous) return { ok: false, error: 'ambiguous-user', retryable: false, matches: cached.matches }
    if (cached?.user) {
      const user = cached.user
      users.push({ id: user.id, handle: user.handle, displayName: user.displayName, realName: user.realName, source: 'persistent-index' })
      continue
    }
    const found = await lookupUser({
      query,
      token: userToken,
      tokenSource: 'user',
      slackCall,
      onDirectoryMembers: fetched => cacheDirectoryMembers({ dbPath, workspaceId, members: fetched.members, truncated: fetched.truncated || dryRun }),
    })
    if (!found.ok) return found
    users.push({ ...found.user, source: found.source })
  }
  const duplicate = users.find((user, index) => users.findIndex(other => other.id === user.id) !== index)
  if (duplicate) return { ok: false, error: 'duplicate-mpim-recipient', retryable: false, user: duplicate }
  return { ok: true, users }
}

function findCachedMpim({ dbPath, workspaceId, tokenIdentity: identity, key }) {
  if (!dbPath) return null
  const row = getDb(dbPath)
    .prepare(
      `SELECT conversation_id, refreshed_at FROM mpim_conversations
       WHERE workspace_id = ? AND token_identity = ? AND member_key = ?`
    )
    .get(workspaceId, identity, key)
  return row && isFresh(row.refreshed_at) ? row.conversation_id : null
}

function cacheMpim({ dbPath, workspaceId, identity, conversationId, members }) {
  if (!dbPath) return
  const db = getDb(dbPath)
  const now = new Date().toISOString()
  const key = memberKey(members)
  db.prepare(
    `INSERT INTO mpim_conversations (workspace_id, token_identity, conversation_id, member_key, refreshed_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(workspace_id, token_identity, conversation_id) DO UPDATE SET
       member_key = excluded.member_key, refreshed_at = excluded.refreshed_at`
  ).run(workspaceId, identity, conversationId, key, now)
}

async function refreshMpims({ userToken, workspaceId, identity, dbPath, slackCall, dryRun, targetKey }) {
  let cursor
  const conversations = new Map()
  for (let page = 0; page < MAX_PAGES; page++) {
    const listed = await slackCall('users.conversations', userToken, { types: 'mpim', exclude_archived: 'true', limit: 200, cursor })
    if (!listed.ok) return listed
    for (const conversation of listed.channels || []) {
      const members = await slackCall('conversations.members', userToken, { channel: conversation.id, limit: 1000 })
      if (!members.ok) return members
      conversations.set(memberKey(members.members || []), conversation.id)
      if (!dryRun) cacheMpim({ dbPath, workspaceId, identity, conversationId: conversation.id, members: members.members || [] })
      if (memberKey(members.members || []) === targetKey) return { ok: true, conversations }
    }
    cursor = listed.response_metadata?.next_cursor
    if (!cursor) return { ok: true, conversations }
  }
  return { ok: false, error: 'mpim-list-truncated', retryable: false }
}

export async function messageGroupByName({ peopleNames, text, userToken, dbPath, dryRun, slackCall = callSlack } = {}) {
  if (!Array.isArray(peopleNames) || peopleNames.length < 2) return { ok: false, error: 'at-least-two-mpim-recipients-required', retryable: false }
  if (!text) return { ok: false, error: 'text-required', retryable: false }
  if (!userToken) return { ok: false, error: 'user-token-required', retryable: false }

  const auth = await slackCall('auth.test', userToken)
  if (!auth.ok) return auth
  const workspaceId = auth.team_id
  const selfUserId = auth.user_id
  if (!workspaceId || !selfUserId) return { ok: false, error: 'user-auth-missing-workspace-or-user', retryable: false }
  const identity = tokenIdentity(userToken)
  const resolved = await resolvePeople({ peopleNames, userToken, workspaceId, dbPath, slackCall, dryRun })
  if (!resolved.ok) return resolved
  const recipientIds = resolved.users.map(user => user.id).filter(id => id !== selfUserId)
  if (recipientIds.length < 2) return { ok: false, error: 'at-least-two-other-mpim-recipients-required', retryable: false }
  const key = memberKey([selfUserId, ...recipientIds])

  let conversationId = dryRun ? null : findCachedMpim({ dbPath, workspaceId, tokenIdentity: identity, key })
  if (!conversationId) {
    const refreshed = await refreshMpims({ userToken, workspaceId, identity, dbPath, slackCall, dryRun, targetKey: key })
    if (!refreshed.ok) return refreshed
    conversationId = refreshed.conversations.get(key) || (dryRun ? null : findCachedMpim({ dbPath, workspaceId, tokenIdentity: identity, key }))
  }
  if (!conversationId) {
    return {
      ok: false,
      error: 'mpim-not-found-confirm-create-first',
      retryable: false,
      workspaceId,
      recipients: resolved.users,
    }
  }
  if (dryRun) return { ok: true, dryRun: true, workspaceId, recipients: resolved.users, conversationId, request: { method: 'chat.postMessage', body: { channel: conversationId, text }, asUser: true } }
  const sent = await slackCall('chat.postMessage', userToken, { channel: conversationId, text })
  return { ...sent, workspaceId, recipients: resolved.users, conversationId, asUser: true }
}
