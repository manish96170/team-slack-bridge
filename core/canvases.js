// Canvases (D72): create, edit, share, find sections of, and delete Slack
// canvases. Reading a canvas goes through core/files.js (a canvas is a file).
// User-token only — a canvas created here belongs to the human.
//
// Slack's own contract: canvases.create / canvases.edit /
// canvases.access.set / canvases.sections.lookup / canvases.delete, plus
// conversations.canvases.create for the single canvas attached to a channel.
// Markdown goes in as document_content { type:'markdown', markdown }.

import { callSlack } from './slack.js'

const EDIT_OPERATIONS = ['insert_at_end', 'insert_at_start', 'insert_after', 'insert_before', 'replace', 'delete']
const NEEDS_SECTION = new Set(['insert_after', 'insert_before', 'delete'])
const NEEDS_CONTENT = new Set(['insert_at_end', 'insert_at_start', 'insert_after', 'insert_before', 'replace'])

export const CANVAS_EDIT_OPERATIONS = EDIT_OPERATIONS

const markdownContent = markdown => ({ type: 'markdown', markdown })

export async function createCanvas({ token, title, markdown, channelId, dryRun, slackCall = callSlack }) {
  if (!channelId && !title) return { ok: false, error: 'title-or-channel-required', retryable: false }
  const document_content = markdownContent(markdown || '')
  const request = channelId
    ? { method: 'conversations.canvases.create', body: { channel_id: channelId, document_content } }
    : { method: 'canvases.create', body: { title, document_content } }
  if (dryRun) return { ok: true, dryRun: true, request }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall(request.method, token, request.body)
}

export async function editCanvas({ token, canvasId, operation = 'insert_at_end', markdown, sectionId, dryRun, slackCall = callSlack }) {
  if (!canvasId) return { ok: false, error: 'canvasId-required', retryable: false }
  if (!EDIT_OPERATIONS.includes(operation)) return { ok: false, error: `invalid-operation-use-${EDIT_OPERATIONS.join('|')}`, retryable: false }
  if (NEEDS_SECTION.has(operation) && !sectionId) return { ok: false, error: 'sectionId-required-for-this-operation', retryable: false }
  if (NEEDS_CONTENT.has(operation) && !markdown) return { ok: false, error: 'markdown-required-for-this-operation', retryable: false }
  const change = {
    operation,
    ...(sectionId && { section_id: sectionId }),
    ...(NEEDS_CONTENT.has(operation) && { document_content: markdownContent(markdown) }),
  }
  const body = { canvas_id: canvasId, changes: [change] }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'canvases.edit', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('canvases.edit', token, body)
}

export async function shareCanvas({ token, canvasId, accessLevel = 'read', channelIds, userIds, dryRun, slackCall = callSlack }) {
  if (!canvasId) return { ok: false, error: 'canvasId-required', retryable: false }
  if (!['read', 'write'].includes(accessLevel)) return { ok: false, error: 'accessLevel-must-be-read-or-write', retryable: false }
  const channels = (channelIds || []).filter(Boolean)
  const users = (userIds || []).filter(Boolean)
  if (!channels.length && !users.length) return { ok: false, error: 'channelIds-or-userIds-required', retryable: false }
  const body = {
    canvas_id: canvasId,
    access_level: accessLevel,
    ...(channels.length && { channel_ids: channels }),
    ...(users.length && { user_ids: users }),
  }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'canvases.access.set', body } }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('canvases.access.set', token, body)
}

export async function lookupCanvasSections({ token, canvasId, containsText, sectionTypes, slackCall = callSlack }) {
  if (!canvasId) return { ok: false, error: 'canvasId-required', retryable: false }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  const criteria = {
    ...(containsText && { contains_text: containsText }),
    ...(sectionTypes?.length && { section_types: sectionTypes }),
  }
  if (!Object.keys(criteria).length) return { ok: false, error: 'containsText-or-sectionTypes-required', retryable: false }
  return slackCall('canvases.sections.lookup', token, { canvas_id: canvasId, criteria })
}

// Deleting a canvas is permanent for everyone it is shared with.
export async function deleteCanvas({ token, canvasId, confirm, dryRun, slackCall = callSlack }) {
  if (!canvasId) return { ok: false, error: 'canvasId-required', retryable: false }
  const body = { canvas_id: canvasId }
  if (dryRun) return { ok: true, dryRun: true, request: { method: 'canvases.delete', body } }
  if (confirm !== true) return { ok: false, error: 'confirm-required-to-delete-canvas', retryable: false, canvasId }
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  return slackCall('canvases.delete', token, body)
}
