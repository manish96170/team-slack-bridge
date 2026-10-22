import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDmChannel, dm } from '../core/dm.js'

function tempDbPath() {
  return join(mkdtempSync(join(tmpdir(), 'dm-cache-test-')), 'db.sqlite')
}

test('resolveDmChannel caches conversations.open by caller-specific cache key', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://slack.com/api/conversations.open',
      headers: {
        get: name => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null),
        entries: () => [][Symbol.iterator](),
      },
      json: async () => ({ ok: true, channel: { id: 'D_CACHE' } }),
      text: async () => JSON.stringify({ ok: true, channel: { id: 'D_CACHE' } }),
    }
  }
  try {
    const dbPath = tempDbPath()
    const first = await resolveDmChannel({ token: 'xoxb-dm-cache-test', userId: 'U1', cacheKey: 'bot:U1', dbPath })
    const second = await resolveDmChannel({ token: 'xoxb-dm-cache-test', userId: 'U1', cacheKey: 'bot:U1', dbPath })
    assert.equal(first.channel.id, 'D_CACHE')
    assert.equal(second.cached, true)
    assert.equal(second.channel.id, 'D_CACHE')
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('resolveDmChannel does not share a bot DM cache entry with an as-user DM', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: 'https://slack.com/api/conversations.open',
      headers: {
        get: name => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null),
        entries: () => [][Symbol.iterator](),
      },
      json: async () => ({ ok: true, channel: { id: `D_${calls}` } }),
      text: async () => JSON.stringify({ ok: true, channel: { id: `D_${calls}` } }),
    }
  }
  try {
    const dbPath = tempDbPath()
    const bot = await resolveDmChannel({ token: 'xoxb-bot', userId: 'U1', cacheKey: 'bot:U1', dbPath })
    const user = await resolveDmChannel({ token: 'xoxp-user', userId: 'U1', cacheKey: 'user:U1', dbPath })
    assert.equal(bot.channel.id, 'D_1')
    assert.equal(user.channel.id, 'D_2')
    assert.equal(calls, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// Fakes both conversations.open and chat.postMessage, recording which
// bearer token hit which method, so the assertions below are against the
// actual `dm()` boundary (the production bug: `dm({ asUser: true })` opened
// the DM with the bot token, then posted with the user token against that
// bot-owned channel). A regression here would mean the real caller-facing
// function broke even if resolveDmChannel()'s own unit tests still passed.
function mockSlackDmTransport() {
  const calls = []
  globalThis.fetch = async (url, init) => {
    const method = String(url).split('/api/')[1]
    const token = init.headers.Authorization.replace('Bearer ', '')
    calls.push({ method, token })
    const body = method === 'conversations.open' ? { ok: true, channel: { id: `D_${token}` } } : { ok: true, channel: `D_${token}`, ts: '1.1' }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url,
      headers: {
        get: name => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null),
        entries: () => [][Symbol.iterator](),
      },
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }
  return calls
}

test('dm() as bot and dm() as user never cross-use each other\'s token or cached channel', async () => {
  const originalFetch = globalThis.fetch
  const calls = mockSlackDmTransport()
  try {
    const dbPath = tempDbPath()
    const botResult = await dm({ botToken: 'xoxb-real-bot', userId: 'U9', text: 'hi', dbPath })
    const userResult = await dm({ userToken: 'xoxp-real-user', userId: 'U9', text: 'hi', asUser: true, dbPath })

    assert.equal(botResult.ok, true)
    assert.equal(userResult.ok, true)

    const botCalls = calls.filter(c => c.token === 'xoxb-real-bot')
    const userCalls = calls.filter(c => c.token === 'xoxp-real-user')
    // Every call this bot send made used the bot token, every call the
    // as-user send made used the user token — neither ever used the other's.
    assert.equal(botCalls.length + userCalls.length, calls.length)
    assert.ok(botCalls.some(c => c.method === 'conversations.open'))
    assert.ok(botCalls.some(c => c.method === 'chat.postMessage'))
    assert.ok(userCalls.some(c => c.method === 'conversations.open'))
    assert.ok(userCalls.some(c => c.method === 'chat.postMessage'))
    // Each identity opened its OWN conversation — the as-user send did not
    // reuse the bot-opened channel ID (the exact bug this fix closes).
    assert.notEqual(botResult.channel, userResult.channel)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('dm({ asUser: true }) with no user token refuses rather than silently falling back to the bot token', async () => {
  const originalFetch = globalThis.fetch
  const calls = mockSlackDmTransport()
  try {
    const dbPath = tempDbPath()
    const result = await dm({ botToken: 'xoxb-real-bot', userId: 'U9', text: 'hi', asUser: true, dbPath })
    assert.deepEqual(result, { ok: false, error: 'user-token-required', retryable: false })
    assert.equal(calls.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rotating SLACK_USER_TOKEN busts the as-user DM cache instead of reusing the previous identity\'s channel', async () => {
  const originalFetch = globalThis.fetch
  const calls = mockSlackDmTransport()
  try {
    const dbPath = tempDbPath()
    const first = await dm({ userToken: 'xoxp-person-a', userId: 'U9', text: 'hi', asUser: true, dbPath })
    const second = await dm({ userToken: 'xoxp-person-b', userId: 'U9', text: 'hi', asUser: true, dbPath })
    // Different token identity against the same recipient must open its own
    // conversation, not reuse person A's cached channel — both open calls
    // happen rather than the second one serving a stale cache hit.
    assert.equal(calls.filter(c => c.method === 'conversations.open').length, 2)
    assert.notEqual(first.channel, second.channel)
  } finally {
    globalThis.fetch = originalFetch
  }
})
