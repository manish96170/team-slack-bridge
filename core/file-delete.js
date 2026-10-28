// Slack file deletion is global to the file, not just one channel/thread share.
// This module has no local filesystem access, unlike the upload implementation.
import { callSlack } from './slack.js'

export async function deleteFile({ token, fileId, confirm, dryRun }) {
  if (typeof fileId !== 'string' || !fileId.trim()) return { ok: false, error: 'fileId-required', retryable: false }
  if (!/^F[A-Z0-9]+$/.test(fileId.trim())) return { ok: false, error: 'invalid-file-id', retryable: false }
  const body = { file: fileId.trim() }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'files.delete', body }, warning: 'Deletes the file from all shares, not just one conversation.' }
  if (confirm !== true) return { ok: false, error: 'file-deletion-confirmation-required', retryable: false }
  const result = await callSlack('files.delete', token, body, { noRetry: true })
  // A lost response can mean Slack applied the deletion; never retry blindly.
  if (!result.ok && (result.error?.startsWith('network-error:') || ['fatal_error', 'internal_error', 'request_timeout'].includes(result.error))) {
    return { ...result, retryable: false, outcomeUnknown: true }
  }
  return result
}
