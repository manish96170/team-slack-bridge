import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveDmChannel } from '../core/dm.js'

function tempDbPath() {
  return join(mkdtempSync(join(tmpdir(), 'dm-cache-test-')), 'db.sqlite')
}

test('resolveDmChannel caches conversations.open by user ID', async () => {
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
    const first = await resolveDmChannel({ token: 'xoxb-dm-cache-test', userId: 'U1', dbPath })
    const second = await resolveDmChannel({ token: 'xoxb-dm-cache-test', userId: 'U1', dbPath })
    assert.equal(first.channel.id, 'D_CACHE')
    assert.equal(second.cached, true)
    assert.equal(second.channel.id, 'D_CACHE')
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
