import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { uploadFile } from '../core/files.js'
import { deleteFile } from '../core/file-delete.js'
import { getSlackClient } from '../core/slack.js'
import { tools as localTools } from '../mcp/tools.local.js'
import { tools as remoteTools } from '../mcp/tools.remote.js'
import { validateArguments } from '../mcp/validation.js'
import { queryLocalFileAudit } from '../core/local-file-delete.js'

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

test('deleteFile requires an exact file ID and explicit confirmation, and previews without a token', async () => {
  assert.equal((await deleteFile({ fileId: '' })).error, 'fileId-required')
  assert.equal((await deleteFile({ fileId: 'f123', dryRun: true })).error, 'invalid-file-id')
  assert.equal((await deleteFile({ fileId: 'F123' })).error, 'file-deletion-confirmation-required')
  assert.equal((await deleteFile({ fileId: 'F123', confirm: true })).error, 'no-token')
  const preview = await deleteFile({ fileId: ' F123 ', dryRun: true })
  assert.deepEqual(preview.request, { method: 'files.delete', body: { file: 'F123' } })
  assert.match(preview.warning, /all shares/)
})

test('deleteFile sends the exact file ID and propagates Slack permission failures', async () => {
  const client = getSlackClient('xoxp-file-delete-test', { noRetry: true })
  const original = client.apiCall
  const calls = []
  try {
    client.apiCall = async (method, body) => { calls.push({ method, body }); return { ok: true } }
    assert.equal((await deleteFile({ token: 'xoxp-file-delete-test', fileId: 'F123', confirm: true })).ok, true)
    assert.deepEqual(calls, [{ method: 'files.delete', body: { file: 'F123' } }])
    client.apiCall = async () => { throw { code: 'slack_webapi_platform_error', data: { error: 'cant_delete_file' } } }
    const result = await deleteFile({ token: 'xoxp-file-delete-test', fileId: 'F123', confirm: true })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'cant_delete_file')
    client.apiCall = async () => { throw { code: 'slack_webapi_request_error', message: 'lost response' } }
    const uncertain = await deleteFile({ token: 'xoxp-file-delete-test', fileId: 'F123', confirm: true })
    assert.equal(uncertain.outcomeUnknown, true)
    assert.equal(uncertain.retryable, false)
  } finally {
    client.apiCall = original
  }
})

test('local file deletion defaults to user and never falls back between identities', async () => {
  const tool = localTools.slack_delete_file
  assert.ok(tool)
  assert.ok(remoteTools.slack_delete_file)
  assert.equal(validateArguments(tool.inputSchema, { fileId: 'F123', confirm: 'true' }), 'confirm must be boolean')
  assert.equal(validateArguments(tool.inputSchema, { fileId: 'F123', channel: 'C123' }), 'unknown argument: channel')
  const dbPath = join(mkdtempSync(join(tmpdir(), 'file-audit-test-')), 'audit.sqlite')
  const config = { fileDeletion: { enabled: true } }
  const disabled = await tool.handler({ fileId: 'F123', confirm: true }, { env: {}, config: {}, dbPath })
  assert.equal(disabled.error, 'file-deletion-disabled')
  const noUser = await tool.handler({ fileId: 'F123', confirm: true }, { env: { SLACK_BOT_TOKEN: 'xoxb-bot' }, config, dbPath })
  assert.equal(noUser.error, 'no-token')
  assert.equal(noUser.tokenSource, 'user')
  const noBot = await tool.handler({ fileId: 'F123', confirm: true, viaBot: true }, { env: { SLACK_USER_TOKEN: 'xoxp-user' }, config, dbPath })
  assert.equal(noBot.error, 'no-token')
  assert.equal(noBot.tokenSource, 'bot')
  const entries = queryLocalFileAudit({ dbPath })
  assert.equal(entries.length, 3)
  assert.equal(entries[0].file_id, 'F123')
  assert.equal(entries[0].token_source, 'bot')
  assert.equal(entries[0].status, 'failed')
  assert.equal(entries[2].error, 'file-deletion-disabled')
})
