import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  lookupUser,
  lookupUserById,
  lookupUserByEmail,
  searchDirectoryByHandleOrName,
  clearDirectoryCache,
} from '../core/directory.js'

const JANE = { id: 'U0JANE001', name: 'jane.doe', real_name: 'Jane Doe', profile: { display_name: 'Jane', real_name: 'Jane Doe', email: 'jane@example.com' } }
const BOT = { id: 'U0BOT0001', name: 'ci-bot', is_bot: true, profile: { display_name: 'CI Bot' } }
const DELETED = { id: 'U0GONE001', name: 'ex.employee', deleted: true, profile: { display_name: 'Ex Employee' } }
const DUP_A = { id: 'U0DUPA001', name: 'alex', real_name: 'Alex Smith', profile: { display_name: 'Alex' } }
const DUP_B = { id: 'U0DUPB001', name: 'alex', real_name: 'Alex Jones', profile: { display_name: 'Alex' } }

function fakePaginatedList(pages) {
  let call = 0
  return async (method, token, body) => {
    assert.equal(method, 'users.list')
    assert.equal(token, 'xoxb-fake')
    const page = pages[call]
    call += 1
    if (!page) return { ok: true, members: [], response_metadata: {} }
    return { ok: true, members: page.members, response_metadata: { next_cursor: page.nextCursor || '' } }
  }
}

test('lookupUser mode:auto routes a Slack ID to users.info', async () => {
  const slackCall = async (method, token, body) => {
    assert.equal(method, 'users.info')
    assert.equal(body.user, 'U0JANE001')
    return { ok: true, user: JANE }
  }
  const result = await lookupUser({ query: 'U0JANE001', token: 'xoxb-fake', slackCall })
  assert.equal(result.ok, true)
  assert.equal(result.source, 'slack-directory')
  assert.equal(result.tokenSource, 'bot')
  assert.deepEqual(result.user, { id: 'U0JANE001', displayName: 'Jane', realName: 'Jane Doe', handle: 'jane.doe', email: null })
})

test('lookupUserById excludes email unless includeEmail:true', async () => {
  const slackCall = async () => ({ ok: true, user: JANE })
  const withoutEmail = await lookupUserById({ token: 'xoxb-fake', userId: 'U0JANE001', slackCall })
  assert.equal(withoutEmail.user.email, null)
  const withEmail = await lookupUserById({ token: 'xoxb-fake', userId: 'U0JANE001', slackCall, includeEmail: true })
  assert.equal(withEmail.user.email, 'jane@example.com')
})

test('lookupUserById reports user-not-found for an unknown ID', async () => {
  const slackCall = async () => ({ ok: false, error: 'user_not_found', retryable: false })
  const result = await lookupUserById({ token: 'xoxb-fake', userId: 'U0NOPE', slackCall })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'user-not-found')
})

test('lookupUserById maps missing_scope with the users:read requirement', async () => {
  const slackCall = async () => ({ ok: false, error: 'missing_scope', retryable: false })
  const result = await lookupUserById({ token: 'xoxb-fake', userId: 'U0JANE001', slackCall })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'missing_scope')
  assert.equal(result.requiredScope, 'users:read')
})

test('lookupUserByEmail resolves an email to a profile, email hidden by default', async () => {
  const slackCall = async (method, token, body) => {
    assert.equal(method, 'users.lookupByEmail')
    assert.equal(body.email, 'jane@example.com')
    return { ok: true, user: JANE }
  }
  const result = await lookupUserByEmail({ token: 'xoxb-fake', email: 'jane@example.com', slackCall })
  assert.equal(result.ok, true)
  assert.equal(result.user.id, 'U0JANE001')
  assert.equal(result.user.email, null)
})

test('lookupUserByEmail reports user-not-found for users_not_found', async () => {
  const slackCall = async () => ({ ok: false, error: 'users_not_found', retryable: false })
  const result = await lookupUserByEmail({ token: 'xoxb-fake', email: 'nobody@example.com', slackCall })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'user-not-found')
})

test('lookupUserByEmail maps missing_scope with the users:read.email requirement', async () => {
  const slackCall = async () => ({ ok: false, error: 'missing_scope', retryable: false })
  const result = await lookupUserByEmail({ token: 'xoxb-fake', email: 'jane@example.com', slackCall })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'missing_scope')
  assert.equal(result.requiredScope, 'users:read.email')
})

test('lookupUser mode:auto routes an email-shaped query to users.lookupByEmail', async () => {
  const slackCall = async method => {
    assert.equal(method, 'users.lookupByEmail')
    return { ok: true, user: JANE }
  }
  const result = await lookupUser({ query: 'jane@example.com', token: 'xoxb-fake', slackCall })
  assert.equal(result.ok, true)
  assert.equal(result.user.id, 'U0JANE001')
})

test('searchDirectoryByHandleOrName matches an exact @handle, normalized', async () => {
  clearDirectoryCache()
  const slackCall = fakePaginatedList([{ members: [JANE, BOT, DELETED] }])
  const result = await searchDirectoryByHandleOrName({ token: 'xoxb-fake', query: '@Jane.Doe', slackCall })
  assert.equal(result.ok, true)
  assert.equal(result.user.id, 'U0JANE001')
})

test('searchDirectoryByHandleOrName matches an exact display name or real name', async () => {
  clearDirectoryCache()
  const slackCall = fakePaginatedList([{ members: [JANE] }])
  const byDisplayName = await searchDirectoryByHandleOrName({ token: 'xoxb-fake', query: 'jane', slackCall })
  assert.equal(byDisplayName.ok, true)
  assert.equal(byDisplayName.user.id, 'U0JANE001')

  clearDirectoryCache()
  const slackCall2 = fakePaginatedList([{ members: [JANE] }])
  const byRealName = await searchDirectoryByHandleOrName({ token: 'xoxb-fake', query: ' Jane Doe ', slackCall: slackCall2 })
  assert.equal(byRealName.ok, true)
  assert.equal(byRealName.user.id, 'U0JANE001')
})

test('searchDirectoryByHandleOrName excludes deleted users and bots by default', async () => {
  clearDirectoryCache()
  const slackCall = fakePaginatedList([{ members: [JANE, BOT, DELETED] }])
  const bot = await searchDirectoryByHandleOrName({ token: 'xoxb-fake', query: 'ci-bot', slackCall })
  assert.equal(bot.ok, false)
  assert.equal(bot.error, 'user-not-found')

  clearDirectoryCache()
  const slackCall2 = fakePaginatedList([{ members: [JANE, BOT, DELETED] }])
  const deleted = await searchDirectoryByHandleOrName({ token: 'xoxb-fake', query: 'ex.employee', slackCall: slackCall2 })
  assert.equal(deleted.ok, false)
  assert.equal(deleted.error, 'user-not-found')
})

test('searchDirectoryByHandleOrName reports user-not-found for no match', async () => {
  clearDirectoryCache()
  const slackCall = fakePaginatedList([{ members: [JANE] }])
  const result = await searchDirectoryByHandleOrName({ token: 'xoxb-fake', query: 'nobody.here', slackCall })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'user-not-found')
})

test('searchDirectoryByHandleOrName reports ambiguous-user with every match, never picking one', async () => {
  clearDirectoryCache()
  const slackCall = fakePaginatedList([{ members: [DUP_A, DUP_B] }])
  const result = await searchDirectoryByHandleOrName({ token: 'xoxb-fake', query: 'alex', slackCall })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'ambiguous-user')
  assert.equal(result.matches.length, 2)
  assert.deepEqual(result.matches.map(m => m.id).sort(), ['U0DUPA001', 'U0DUPB001'])
})

test('searchDirectoryByHandleOrName follows pagination across multiple pages', async () => {
  clearDirectoryCache()
  const slackCall = fakePaginatedList([{ members: [BOT], nextCursor: 'page2' }, { members: [JANE] }])
  const result = await searchDirectoryByHandleOrName({ token: 'xoxb-fake', query: 'jane.doe', slackCall })
  assert.equal(result.ok, true)
  assert.equal(result.user.id, 'U0JANE001')
})

test('searchDirectoryByHandleOrName caches users.list across calls within the TTL', async () => {
  clearDirectoryCache()
  let calls = 0
  const slackCall = async (method, token, body) => {
    calls += 1
    return { ok: true, members: [JANE], response_metadata: {} }
  }
  await searchDirectoryByHandleOrName({ token: 'xoxb-fake', query: 'jane.doe', slackCall, ttlMs: 60_000 })
  await searchDirectoryByHandleOrName({ token: 'xoxb-fake', query: 'jane', slackCall, ttlMs: 60_000 })
  assert.equal(calls, 1, 'second lookup should hit the cache, not Slack again')
})

test('searchDirectoryByHandleOrName never caches a failed users.list page', async () => {
  clearDirectoryCache()
  let calls = 0
  const slackCall = async () => {
    calls += 1
    return { ok: false, error: 'missing_scope', retryable: false }
  }
  const first = await searchDirectoryByHandleOrName({ token: 'xoxb-fake', query: 'jane', slackCall, ttlMs: 60_000 })
  assert.equal(first.ok, false)
  assert.equal(first.error, 'missing_scope')
  assert.equal(first.requiredScope, 'users:read')

  const second = await searchDirectoryByHandleOrName({ token: 'xoxb-fake', query: 'jane', slackCall, ttlMs: 60_000 })
  assert.equal(second.ok, false)
  assert.equal(calls, 2, 'a failure must never be served from cache')
})

test('lookupUser without a token fails clearly instead of calling Slack', async () => {
  const result = await lookupUser({ query: 'jane', token: undefined, slackCall: async () => { throw new Error('should not be called') } })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-token')
})

test('lookupUser with an empty query fails clearly instead of calling Slack', async () => {
  const result = await lookupUser({ query: '   ', token: 'xoxb-fake', slackCall: async () => { throw new Error('should not be called') } })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'query-required')
})

test('mode:"name" uses the same directory search as mode:"handle"', async () => {
  clearDirectoryCache()
  const slackCall = fakePaginatedList([{ members: [JANE] }])
  const result = await lookupUser({ query: 'Jane Doe', mode: 'name', token: 'xoxb-fake', slackCall })
  assert.equal(result.ok, true)
  assert.equal(result.user.id, 'U0JANE001')
})

test('core/directory.js never imports the config-write module — a lookup can never mutate slack-config.json', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { join, dirname } = await import('node:path')
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const source = readFileSync(join(repoRoot, 'core/directory.js'), 'utf8')
  assert.ok(!source.includes('config-write'))
  assert.ok(!source.includes('writeFileSync'))
})

test('lookupUser/lookupUserById/lookupUserByEmail/searchDirectoryByHandleOrName never touch slack-config.json even on a successful lookup', async () => {
  clearDirectoryCache()
  const configPath = '/tmp/should-never-be-touched-slack-config.json'
  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(configPath), false)

  await lookupUserById({ token: 'xoxb-fake', userId: 'U0JANE001', slackCall: async () => ({ ok: true, user: JANE }) })
  await lookupUserByEmail({ token: 'xoxb-fake', email: 'jane@example.com', slackCall: async () => ({ ok: true, user: JANE }) })
  await searchDirectoryByHandleOrName({ token: 'xoxb-fake', query: 'jane.doe', slackCall: fakePaginatedList([{ members: [JANE] }]) })

  // None of the lookup functions accept a configPath at all — this is a
  // belt-and-braces check that nothing was ever created on disk by them.
  assert.equal(existsSync(configPath), false)
})
