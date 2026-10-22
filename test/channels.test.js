import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listMyChannels } from '../core/channels.js'

test('listMyChannels short-circuits with no-token, never calling the network', async () => {
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async () => {
    called = true
    throw new Error('must not be called')
  }
  try {
    const result = await listMyChannels({ token: undefined })
    assert.deepEqual(result, { ok: false, error: 'no-token', retryable: false })
    assert.equal(called, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('listMyChannels calls users.conversations (not conversations.list) with public+private defaults', async () => {
  const originalFetch = globalThis.fetch
  let seenUrl, seenBody
  globalThis.fetch = async (url, init) => {
    seenUrl = url
    seenBody = Object.fromEntries(new URLSearchParams(init.body))
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url,
      headers: {
        get: name => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null),
        entries: () => [][Symbol.iterator](),
      },
      json: async () => ({ ok: true, channels: [{ id: 'C1', name: 'general' }] }),
      text: async () => JSON.stringify({ ok: true, channels: [{ id: 'C1', name: 'general' }] }),
    }
  }
  try {
    const result = await listMyChannels({ token: 'xoxp-user' })
    assert.ok(String(seenUrl).includes('users.conversations'))
    assert.ok(!String(seenUrl).includes('conversations.list'))
    assert.equal(seenBody.types, 'public_channel,private_channel')
    assert.equal(seenBody.exclude_archived, 'true')
    assert.equal(result.ok, true)
    assert.equal(result.channels[0].id, 'C1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('listMyChannels passes through a caller-supplied types filter and cursor', async () => {
  const originalFetch = globalThis.fetch
  let seenBody
  globalThis.fetch = async (url, init) => {
    seenBody = Object.fromEntries(new URLSearchParams(init.body))
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url,
      headers: {
        get: name => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null),
        entries: () => [][Symbol.iterator](),
      },
      json: async () => ({ ok: true, channels: [] }),
      text: async () => JSON.stringify({ ok: true, channels: [] }),
    }
  }
  try {
    await listMyChannels({ token: 'xoxp-user-2', types: 'public_channel,mpim,im', cursor: 'next-page' })
    assert.equal(seenBody.types, 'public_channel,mpim,im')
    assert.equal(seenBody.cursor, 'next-page')
  } finally {
    globalThis.fetch = originalFetch
  }
})
