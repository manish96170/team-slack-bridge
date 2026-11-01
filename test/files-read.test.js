import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getFileInfo, listFiles, readFile, htmlToText } from '../core/files.js'

function fakeSlack(files) {
  const calls = []
  const slackCall = async (method, token, body = {}) => {
    calls.push({ method, token, body })
    if (method === 'files.info') return files[body.file] ? { ok: true, file: files[body.file] } : { ok: false, error: 'file_not_found', retryable: false }
    if (method === 'files.list') return { ok: true, files: Object.values(files), paging: { count: 1 } }
    return { ok: true }
  }
  return { calls, slackCall }
}

function response(body, { status = 200, contentType = 'application/octet-stream' } = {}) {
  const bytes = typeof body === 'string' ? Buffer.from(body) : body
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => (name.toLowerCase() === 'content-type' ? contentType : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  }
}

const TEXT_FILE = { id: 'F1', name: 'notes.txt', mimetype: 'text/plain', filetype: 'text', size: 11, url_private: 'https://files.slack.com/files-pri/T1-F1/notes.txt' }
const PNG_FILE = { id: 'F2', name: 'shot one.png', mimetype: 'image/png', filetype: 'png', size: 4, url_private: 'https://files.slack.com/files-pri/T1-F2/shot.png' }
const CANVAS = { id: 'F3', name: 'Runbook', title: 'Runbook', mimetype: 'text/html', filetype: 'quip', size: 80, url_private: 'https://files.slack.com/files-pri/T1-F3/canvas' }

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-files-'))
  return Promise.resolve().then(() => fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

test('getFileInfo / listFiles return a summarized shape and validate input', async () => {
  const { slackCall } = fakeSlack({ F1: TEXT_FILE, F3: CANVAS })
  const info = await getFileInfo({ token: 't', fileId: 'F3', slackCall })
  assert.equal(info.file.isCanvas, true)
  assert.equal(info.file.hasPrivateUrl, true)
  assert.equal(info.file.url_private, undefined, 'the private URL itself is not echoed')
  assert.equal((await getFileInfo({ token: 't', fileId: 'F9', slackCall })).error, 'file_not_found')
  assert.equal((await getFileInfo({ token: 't', slackCall })).error, 'fileId-required')
  assert.equal((await getFileInfo({ fileId: 'F1', slackCall })).error, 'no-token')
  const listed = await listFiles({ token: 't', channel: 'C1', count: 500, slackCall })
  assert.equal(listed.files.length, 2)
})

test('listFiles passes filters through and clamps count', async () => {
  const { calls, slackCall } = fakeSlack({ F1: TEXT_FILE })
  await listFiles({ token: 't', channel: 'C1', userId: 'U1', types: 'pdfs', count: 500, slackCall })
  assert.deepEqual(calls[0].body, { count: '100', channel: 'C1', user: 'U1', types: 'pdfs' })
})

test('readFile returns text inline, authenticated, with truncation reported', async () => {
  const { slackCall } = fakeSlack({ F1: TEXT_FILE })
  const requests = []
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), init })
    return response('hello world', { contentType: 'text/plain' })
  }
  const full = await readFile({ token: 'xoxp-secret', fileId: 'F1', fetchImpl, slackCall })
  assert.equal(full.kind, 'text')
  assert.equal(full.text, 'hello world')
  assert.equal(full.truncated, false)
  assert.equal(requests[0].init.headers.Authorization, 'Bearer xoxp-secret')
  assert.equal(requests[0].init.redirect, 'manual')
  const cut = await readFile({ token: 't', fileId: 'F1', maxChars: 5, fetchImpl, slackCall })
  assert.equal(cut.text, 'hello')
  assert.equal(cut.truncated, true)
  assert.equal(cut.totalChars, 11)
})

test('readFile turns a canvas (HTML) into readable text', async () => {
  const { slackCall } = fakeSlack({ F3: CANVAS })
  const html = '<h1>Runbook</h1><p>Step &amp; one</p><ul><li>alpha</li><li>beta</li></ul><script>evil()</script>'
  const result = await readFile({ token: 't', fileId: 'F3', fetchImpl: async () => response(html, { contentType: 'text/html' }), slackCall })
  assert.equal(result.kind, 'text')
  assert.match(result.text, /Runbook/)
  assert.match(result.text, /Step & one/)
  assert.match(result.text, /- alpha/)
  assert.doesNotMatch(result.text, /evil|<h1>/)
  assert.equal(htmlToText('a<br>b&nbsp;c'), 'a\nb c')
})

test('readFile saves binary files under destDir with a sanitized name and 0600 permissions', async () =>
  withTempDir(async dir => {
    const { slackCall } = fakeSlack({ F2: PNG_FILE })
    const destDir = join(dir, 'downloads')
    const result = await readFile({ token: 't', fileId: 'F2', destDir, fetchImpl: async () => response(Buffer.from([1, 2, 3, 4])), slackCall })
    assert.equal(result.kind, 'binary')
    assert.equal(result.localPath, join(destDir, 'F2-shot_one.png'))
    assert.deepEqual([...readFileSync(result.localPath)], [1, 2, 3, 4])
    assert.equal(statSync(result.localPath).mode & 0o777, 0o600)
    assert.equal((await readFile({ token: 't', fileId: 'F2', fetchImpl: async () => response(Buffer.from([1])), slackCall })).error, 'destDir-required-for-binary-files')
    assert.equal(existsSync(join(destDir, 'F2-shot_one.png')), true)
  }))

test('readFile never sends the token to a non-Slack host and does not follow redirects', async () => {
  const evil = { ...TEXT_FILE, url_private: 'https://evil.example.com/steal' }
  const lookalike = { ...TEXT_FILE, id: 'F4', url_private: 'https://files.slack.com.evil.io/x' }
  const insecure = { ...TEXT_FILE, id: 'F5', url_private: 'http://files.slack.com/x' }
  const { slackCall } = fakeSlack({ F1: evil, F4: lookalike, F5: insecure, F6: { ...TEXT_FILE, id: 'F6' } })
  let fetched = 0
  const fetchImpl = async () => {
    fetched++
    return response('', { status: 302 })
  }
  for (const id of ['F1', 'F4', 'F5']) {
    assert.equal((await readFile({ token: 't', fileId: id, fetchImpl, slackCall })).error, 'refusing-non-slack-file-host', id)
  }
  assert.equal(fetched, 0)
  const redirected = await readFile({ token: 't', fileId: 'F6', fetchImpl, slackCall })
  assert.equal(redirected.error, 'file-download-not-authorized-check-files-read-scope')
  assert.equal(fetched, 1)
})

test('readFile rejects a login page served for a binary file, oversize files, missing content and HTTP errors', async () => {
  const { slackCall } = fakeSlack({ F2: PNG_FILE, F1: { ...TEXT_FILE, size: 10_000_000 }, F7: { ...TEXT_FILE, id: 'F7', url_private: undefined } })
  const loginPage = async () => response('<html>sign in</html>', { contentType: 'text/html; charset=utf-8' })
  assert.equal((await readFile({ token: 't', fileId: 'F2', destDir: tmpdir(), fetchImpl: loginPage, slackCall })).error, 'file-download-not-authorized-check-files-read-scope')
  assert.equal((await readFile({ token: 't', fileId: 'F1', fetchImpl: loginPage, slackCall })).error, 'file-too-large')
  assert.equal((await readFile({ token: 't', fileId: 'F7', fetchImpl: loginPage, slackCall })).error, 'file-has-no-downloadable-content')
  const server = await readFile({ token: 't', fileId: 'F2', destDir: tmpdir(), fetchImpl: async () => response('', { status: 503 }), slackCall })
  assert.equal(server.error, 'download-failed: HTTP 503')
  assert.equal(server.retryable, true)
  const transport = await readFile({ token: 't', fileId: 'F2', destDir: tmpdir(), fetchImpl: async () => { throw new Error('boom') }, slackCall })
  assert.equal(transport.retryable, true)
  assert.equal((await readFile({ fileId: 'F2', slackCall })).error, 'no-token')
  assert.equal((await readFile({ token: 't', slackCall })).error, 'fileId-required')
})
