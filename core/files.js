// File/attachment uploads (PLAN D45, §17) — screenshots and video evidence
// attached to a Slack message/thread, e.g. the push-mr-to-slack skill's
// announcement. Slack's old `files.upload` is deprecated; this uses the
// current 3-step flow: `files.getUploadURLExternal` (get a URL + file id),
// a plain POST of the raw bytes to that URL (not a Slack API call — a
// different host entirely), then `files.completeUploadExternal`, which can
// also share the finished upload straight into a channel/thread in the same
// call.

import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
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
