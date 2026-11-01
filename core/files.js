// File/attachment uploads (PLAN D45, §17) — screenshots and video evidence
// attached to a Slack message/thread, e.g. the push-mr-to-slack skill's
// announcement. Slack's old `files.upload` is deprecated; this uses the
// current 3-step flow: `files.getUploadURLExternal` (get a URL + file id),
// a plain POST of the raw bytes to that URL (not a Slack API call — a
// different host entirely), then `files.completeUploadExternal`, which can
// also share the finished upload straight into a channel/thread in the same
// call.

import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, join, relative, isAbsolute } from 'node:path'
import { callSlack } from './slack.js'

export async function uploadFile({ token, filePath, filename, title, channel, threadTs, dryRun }) {
  if (!filePath) return { ok: false, error: 'filePath-required', retryable: false }
  const resolvedFilename = filename || basename(filePath)
  if (dryRun) {
    return { ok: true, dryRun: true, request: { filePath, filename: resolvedFilename, title, channel, threadTs } }
  }
  if (!token) return { ok: false, error: 'no-token', retryable: false }

  let size
  try {
    size = statSync(filePath).size
  } catch {
    return { ok: false, error: 'file-not-found', retryable: false }
  }

  const urlResult = await callSlack('files.getUploadURLExternal', token, { filename: resolvedFilename, length: size })
  if (!urlResult.ok) return urlResult

  let putResponse
  try {
    const bytes = readFileSync(filePath)
    const form = new FormData()
    form.append('file', new Blob([bytes]), resolvedFilename)
    putResponse = await fetch(urlResult.upload_url, { method: 'POST', body: form })
  } catch (err) {
    return { ok: false, error: `upload-transport-error: ${err.message}`, retryable: true }
  }
  if (!putResponse.ok) {
    return { ok: false, error: `upload-failed: HTTP ${putResponse.status}`, retryable: putResponse.status >= 500 }
  }

  const complete = { files: [{ id: urlResult.file_id, title: title || resolvedFilename }] }
  if (channel) complete.channel_id = channel
  if (threadTs) complete.thread_ts = threadTs

  return callSlack('files.completeUploadExternal', token, complete)
}

// ---------------------------------------------------------------------------
// Reading files other people posted (D72). Needs files:read. A message's JSON
// (slack_get_thread / slack_query_messages) lists `files[].id`; these turn an
// id into metadata, a listing, or the content itself. Canvases are files too
// (filetype "quip", HTML body), so slack_file read doubles as canvas reading.
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_CHARS = 20000
const TEXT_MIMETYPES = new Set(['application/json', 'application/xml', 'application/x-yaml', 'application/yaml', 'application/javascript', 'application/x-sh', 'application/sql'])
const TEXT_FILETYPES = new Set(['text', 'json', 'xml', 'yaml', 'csv', 'markdown', 'javascript', 'typescript', 'python', 'shell', 'sql', 'html', 'quip', 'space', 'post'])

function summarize(file) {
  return {
    id: file.id,
    name: file.name,
    title: file.title,
    mimetype: file.mimetype,
    filetype: file.filetype,
    size: file.size,
    created: file.created,
    user: file.user,
    isCanvas: file.filetype === 'quip' || file.filetype === 'canvas',
    permalink: file.permalink,
    hasPrivateUrl: !!file.url_private,
  }
}

export async function getFileInfo({ token, fileId, slackCall = callSlack }) {
  if (!fileId) return { ok: false, error: 'fileId-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  const info = await slackCall('files.info', token, { file: fileId })
  if (!info.ok) return info
  return { ok: true, file: summarize(info.file) }
}

export async function listFiles({ token, channel, userId, types, count = 20, slackCall = callSlack }) {
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  const params = { count: String(Math.min(Math.max(Math.floor(Number(count)) || 20, 1), 100)) }
  if (channel) params.channel = channel
  if (userId) params.user = userId
  if (types) params.types = types
  const listed = await slackCall('files.list', token, params)
  if (!listed.ok) return listed
  return { ok: true, files: (listed.files || []).map(summarize), paging: listed.paging }
}

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|h[1-6]|li|tr|ul|ol|table|section)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function isTextLike(file) {
  const mimetype = (file.mimetype || '').toLowerCase()
  return mimetype.startsWith('text/') || TEXT_MIMETYPES.has(mimetype) || TEXT_FILETYPES.has((file.filetype || '').toLowerCase())
}

function isSlackHost(hostname) {
  return hostname === 'slack.com' || hostname.endsWith('.slack.com')
}

// Slack file IDs are plain alphanumerics (F0123ABCD). The ID comes from an API
// response, so it is validated rather than trusted as a path component.
const FILE_ID_PATTERN = /^[A-Za-z0-9]{1,40}$/

function safeName(file) {
  const base = basename(file.name || file.title || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'file'
  return `${file.id}-${base}`
}

// Reads the body while counting bytes and stops as soon as maxBytes is
// exceeded, so a response that lies about (or omits) its size cannot make us
// buffer an arbitrary amount of memory. Content-Length, when present, is
// checked before reading anything.
async function readBodyCapped(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return { tooLarge: true }
  if (!response.body) return { bytes: Buffer.alloc(0) }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      return { tooLarge: true }
    }
    chunks.push(Buffer.from(value))
  }
  return { bytes: Buffer.concat(chunks, total) }
}

// Writes inside destDir only: the target must resolve under the real
// destDir, and the bytes go to a fresh exclusive temp file that is then
// renamed over the target. rename() replaces a pre-existing symlink at the
// target instead of following it, so a planted link cannot redirect the write.
function saveInsideDir(destDir, name, bytes) {
  mkdirSync(destDir, { recursive: true, mode: 0o700 })
  const root = realpathSync(destDir)
  const target = join(root, name)
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.includes('/') || rel.includes('\\')) return null
  const temp = join(root, `.tmp-${randomBytes(8).toString('hex')}`)
  try {
    writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' })
    renameSync(temp, target)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
  return target
}

// Text-like files (and canvases) come back inline, truncated to maxChars.
// Anything else is saved under destDir (0600) and returned as a local path so
// the caller can open an image/PDF itself. The download only ever goes to a
// slack.com host and never follows redirects: the bearer token must not be
// replayed anywhere else, and a redirect is how Slack answers a missing
// files:read scope (with a login page), which is reported rather than saved.
export async function readFile({ token, fileId, destDir, maxBytes = DEFAULT_MAX_BYTES, maxChars = DEFAULT_MAX_CHARS, fetchImpl = fetch, slackCall = callSlack }) {
  if (!fileId) return { ok: false, error: 'fileId-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  const info = await slackCall('files.info', token, { file: fileId })
  if (!info.ok) return info
  const file = info.file
  const meta = summarize(file)
  if (!FILE_ID_PATTERN.test(String(file.id || ''))) return { ok: false, error: 'invalid-file-id-in-response', retryable: false }
  if (!file.url_private) return { ok: false, error: 'file-has-no-downloadable-content', retryable: false, file: meta }
  if (file.size && file.size > maxBytes) return { ok: false, error: 'file-too-large', retryable: false, file: meta, maxBytes }

  let url
  try {
    url = new URL(file.url_private)
  } catch {
    return { ok: false, error: 'invalid-file-url', retryable: false, file: meta }
  }
  if (url.protocol !== 'https:' || !isSlackHost(url.hostname)) return { ok: false, error: 'refusing-non-slack-file-host', retryable: false, file: meta }

  let response
  try {
    response = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' })
  } catch (err) {
    return { ok: false, error: `download-transport-error: ${err.message}`, retryable: true, file: meta }
  }
  if (response.status >= 300 && response.status < 400) return { ok: false, error: 'file-download-not-authorized-check-files-read-scope', retryable: false, file: meta }
  if (!response.ok) return { ok: false, error: `download-failed: HTTP ${response.status}`, retryable: response.status >= 500, file: meta }

  let body
  try {
    body = await readBodyCapped(response, maxBytes)
  } catch (err) {
    return { ok: false, error: `download-transport-error: ${err.message}`, retryable: true, file: meta }
  }
  if (body.tooLarge) return { ok: false, error: 'file-too-large', retryable: false, file: meta, maxBytes }
  const bytes = body.bytes
  const contentType = (response.headers.get('content-type') || '').toLowerCase()
  if (contentType.includes('text/html') && !isTextLike(file)) {
    return { ok: false, error: 'file-download-not-authorized-check-files-read-scope', retryable: false, file: meta }
  }

  if (isTextLike(file)) {
    const raw = bytes.toString('utf8')
    const text = /html|quip/i.test(`${file.mimetype} ${file.filetype}`) || contentType.includes('text/html') ? htmlToText(raw) : raw
    const truncated = text.length > maxChars
    return { ok: true, file: meta, kind: 'text', text: truncated ? text.slice(0, maxChars) : text, truncated, totalChars: text.length }
  }

  if (!destDir) return { ok: false, error: 'destDir-required-for-binary-files', retryable: false, file: meta }
  let localPath
  try {
    localPath = saveInsideDir(destDir, safeName(file), bytes)
  } catch (err) {
    return { ok: false, error: `could-not-save-file: ${err.message}`, retryable: false, file: meta }
  }
  if (!localPath) return { ok: false, error: 'refusing-path-outside-downloads-dir', retryable: false, file: meta }
  return { ok: true, file: meta, kind: 'binary', localPath, bytes: bytes.length }
}
