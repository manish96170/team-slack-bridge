import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uploadFile } from '../core/files.js'

function tempFile(content = 'fake screenshot bytes') {
  const path = join(mkdtempSync(join(tmpdir(), 'files-test-')), 'evidence.png')
  writeFileSync(path, content)
  return path
}

test('uploadFile requires filePath, never touching the network', async () => {
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async () => {
    called = true
    throw new Error('must not be called')
  }
  try {
    const result = await uploadFile({ token: 'xoxb-test' })
    assert.deepEqual(result, { ok: false, error: 'filePath-required', retryable: false })
    assert.equal(called, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('uploadFile dry-run resolves the request shape without touching fs or network', async () => {
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async () => {
    called = true
    throw new Error('must not be called')
  }
  try {
    const result = await uploadFile({ token: 'xoxb-test', filePath: '/does/not/exist.png', title: 'Evidence', dryRun: true })
    assert.equal(result.ok, true)
    assert.equal(result.dryRun, true)
    assert.equal(result.request.filename, 'exist.png')
    assert.equal(called, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('uploadFile requires a token once a real file is given', async () => {
  const path = tempFile()
  const result = await uploadFile({ filePath: path })
  assert.deepEqual(result, { ok: false, error: 'no-token', retryable: false })
})

test('uploadFile reports file-not-found clearly instead of throwing', async () => {
  const result = await uploadFile({ token: 'xoxb-test', filePath: '/definitely/does/not/exist.png' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'file-not-found')
})

test('uploadFile runs the full 3-step flow: getUploadURLExternal, raw POST, completeUploadExternal', async () => {
  const path = tempFile()
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, init) => {
    const urlStr = String(url)
    calls.push(urlStr)
    if (urlStr.includes('files.getUploadURLExternal')) {
      const body = { ok: true, upload_url: 'https://files.slack.com/upload/v1/fake', file_id: 'F123' }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        url: urlStr,
        headers: { get: n => (n.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null), entries: () => [][Symbol.iterator]() },
        json: async () => body,
        text: async () => JSON.stringify(body),
      }
    }
    if (urlStr.includes('files.slack.com/upload')) {
      return { ok: true, status: 200 }
    }
    if (urlStr.includes('files.completeUploadExternal')) {
      const body = { ok: true, files: [{ id: 'F123', title: 'Evidence' }] }
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        url: urlStr,
        headers: { get: n => (n.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null), entries: () => [][Symbol.iterator]() },
        json: async () => body,
        text: async () => JSON.stringify(body),
      }
    }
    throw new Error(`unexpected fetch: ${urlStr}`)
  }
  try {
    const result = await uploadFile({ token: 'xoxb-upload-test', filePath: path, title: 'Evidence', channel: 'C123', threadTs: '169.1' })
    assert.equal(result.ok, true)
    assert.ok(calls.some(u => u.includes('files.getUploadURLExternal')))
    assert.ok(calls.some(u => u.includes('files.slack.com/upload')))
    assert.ok(calls.some(u => u.includes('files.completeUploadExternal')))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('uploadFile surfaces a failed getUploadURLExternal without attempting the POST or complete step', async () => {
  const path = tempFile()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async url => {
    calls++
    const body = { ok: false, error: 'missing_scope' }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      url: String(url),
      headers: { get: n => (n.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null), entries: () => [][Symbol.iterator]() },
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }
  try {
    const result = await uploadFile({ token: 'xoxb-upload-test-2', filePath: path })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'missing_scope')
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})
