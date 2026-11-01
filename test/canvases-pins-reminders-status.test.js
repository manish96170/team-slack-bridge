import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCanvas, editCanvas, shareCanvas, lookupCanvasSections, deleteCanvas } from '../core/canvases.js'
import { pinMessage, unpinMessage, listPins, addBookmark, listBookmarks, editBookmark, removeBookmark } from '../core/pins.js'
import { addReminder, listReminders, completeReminder, deleteReminder, normalizeReminderTime } from '../core/reminders.js'
import { lookupUserGroup } from '../core/usergroups.js'
import { setStatus, setPresence, manageDnd } from '../core/status.js'

function fakeSlack(responses = {}) {
  const calls = []
  const slackCall = async (method, token, body = {}) => {
    calls.push({ method, token, body })
    const handler = responses[method]
    return handler ? handler(body) : { ok: true }
  }
  return { calls, slackCall }
}

// ---- canvases ----

test('createCanvas: standalone vs channel canvas, markdown document_content, dry-run and token checks', async () => {
  const { calls, slackCall } = fakeSlack({ 'canvases.create': () => ({ ok: true, canvas_id: 'F0CAN' }) })
  const made = await createCanvas({ token: 'xoxp', title: 'Runbook', markdown: '# Hi', slackCall })
  assert.equal(made.canvas_id, 'F0CAN')
  assert.deepEqual(calls[0], { method: 'canvases.create', token: 'xoxp', body: { title: 'Runbook', document_content: { type: 'markdown', markdown: '# Hi' } } })
  const channel = await createCanvas({ token: 'xoxp', channelId: 'C1', markdown: '# Notes', dryRun: true, slackCall })
  assert.equal(channel.request.method, 'conversations.canvases.create')
  assert.equal(channel.request.body.channel_id, 'C1')
  assert.equal((await createCanvas({ token: 'xoxp', slackCall })).error, 'title-or-channel-required')
  assert.equal((await createCanvas({ title: 'x', slackCall })).error, 'no-token')
})

test('editCanvas enforces what each operation needs and builds a single change', async () => {
  const { calls, slackCall } = fakeSlack()
  assert.equal((await editCanvas({ token: 't', canvasId: 'F1', operation: 'explode', markdown: 'x', slackCall })).error.startsWith('invalid-operation'), true)
  assert.equal((await editCanvas({ token: 't', canvasId: 'F1', operation: 'insert_after', markdown: 'x', slackCall })).error, 'sectionId-required-for-this-operation')
  assert.equal((await editCanvas({ token: 't', canvasId: 'F1', operation: 'replace', slackCall })).error, 'markdown-required-for-this-operation')
  assert.equal((await editCanvas({ token: 't', slackCall })).error, 'canvasId-required')
  await editCanvas({ token: 't', canvasId: 'F1', markdown: 'appended', slackCall })
  await editCanvas({ token: 't', canvasId: 'F1', operation: 'delete', sectionId: 'temp:C:1', slackCall })
  assert.deepEqual(calls[0].body, { canvas_id: 'F1', changes: [{ operation: 'insert_at_end', document_content: { type: 'markdown', markdown: 'appended' } }] })
  assert.deepEqual(calls[1].body, { canvas_id: 'F1', changes: [{ operation: 'delete', section_id: 'temp:C:1' }] })
})

test('shareCanvas needs a target and a valid access level; sections lookup needs criteria', async () => {
  const { calls, slackCall } = fakeSlack()
  assert.equal((await shareCanvas({ token: 't', canvasId: 'F1', slackCall })).error, 'channelIds-or-userIds-required')
  assert.equal((await shareCanvas({ token: 't', canvasId: 'F1', accessLevel: 'owner', userIds: ['U1'], slackCall })).error, 'accessLevel-must-be-read-or-write')
  await shareCanvas({ token: 't', canvasId: 'F1', accessLevel: 'write', channelIds: ['C1'], userIds: ['U1'], slackCall })
  assert.deepEqual(calls[0].body, { canvas_id: 'F1', access_level: 'write', channel_ids: ['C1'], user_ids: ['U1'] })
  assert.equal((await lookupCanvasSections({ token: 't', canvasId: 'F1', slackCall })).error, 'containsText-or-sectionTypes-required')
  await lookupCanvasSections({ token: 't', canvasId: 'F1', containsText: 'Todo', sectionTypes: ['h2'], slackCall })
  assert.deepEqual(JSON.parse(calls[1].body.criteria), { contains_text: 'Todo', section_types: ['h2'] })
})

test('deleteCanvas is refused without confirm:true, previews with dryRun, and deletes only when confirmed', async () => {
  const { calls, slackCall } = fakeSlack()
  const refused = await deleteCanvas({ token: 't', canvasId: 'F1', slackCall })
  assert.equal(refused.error, 'confirm-required-to-delete-canvas')
  assert.equal(refused.canvasId, 'F1')
  assert.equal((await deleteCanvas({ token: 't', canvasId: 'F1', confirm: 'yes', slackCall })).error, 'confirm-required-to-delete-canvas')
  assert.equal((await deleteCanvas({ token: 't', canvasId: 'F1', dryRun: true, slackCall })).dryRun, true)
  assert.equal(calls.length, 0)
  assert.equal((await deleteCanvas({ token: 't', canvasId: 'F1', confirm: true, slackCall })).ok, true)
  assert.equal(calls[0].method, 'canvases.delete')
})

// ---- pins / bookmarks ----

test('pins: add/remove need channel and ts; list needs channel; dry-run previews', async () => {
  const { calls, slackCall } = fakeSlack()
  assert.equal((await pinMessage({ token: 't', channel: 'C1', slackCall })).error, 'channel-and-ts-required')
  assert.equal((await unpinMessage({ token: 't', ts: '1.1', slackCall })).error, 'channel-and-ts-required')
  await pinMessage({ token: 't', channel: 'C1', ts: '1.1', slackCall })
  await unpinMessage({ token: 't', channel: 'C1', ts: '1.1', slackCall })
  await listPins({ token: 't', channel: 'C1', slackCall })
  assert.deepEqual(calls.map(call => [call.method, call.body]), [
    ['pins.add', { channel: 'C1', timestamp: '1.1' }],
    ['pins.remove', { channel: 'C1', timestamp: '1.1' }],
    ['pins.list', { channel: 'C1' }],
  ])
  assert.equal((await pinMessage({ channel: 'C1', ts: '1.1', dryRun: true, slackCall })).request.method, 'pins.add')
  assert.equal((await listPins({ channel: 'C1', slackCall })).error, 'no-token')
})

test('bookmarks: http(s) links only, required fields enforced, edit needs a change', async () => {
  const { calls, slackCall } = fakeSlack()
  assert.equal((await addBookmark({ token: 't', channel: 'C1', title: 'Docs', link: 'javascript:alert(1)', slackCall })).error, 'valid-http-link-required')
  assert.equal((await addBookmark({ token: 't', channel: 'C1', link: 'https://x.example', slackCall })).error, 'title-required')
  await addBookmark({ token: 't', channel: 'C1', title: 'Docs', link: 'https://docs.example.com', emoji: ':book:', slackCall })
  assert.deepEqual(calls[0].body, { channel_id: 'C1', title: 'Docs', type: 'link', link: 'https://docs.example.com', emoji: ':book:' })
  await listBookmarks({ token: 't', channel: 'C1', slackCall })
  assert.equal((await editBookmark({ token: 't', channel: 'C1', bookmarkId: 'Bk1', slackCall })).error, 'title-link-or-emoji-required')
  await editBookmark({ token: 't', channel: 'C1', bookmarkId: 'Bk1', title: 'New', slackCall })
  await removeBookmark({ token: 't', channel: 'C1', bookmarkId: 'Bk1', slackCall })
  assert.deepEqual(calls.slice(1).map(call => call.method), ['bookmarks.list', 'bookmarks.edit', 'bookmarks.remove'])
  assert.deepEqual(calls[2].body, { channel_id: 'C1', bookmark_id: 'Bk1', title: 'New' })
})

// ---- reminders ----

test('normalizeReminderTime handles ISO, unix, seconds-from-now and natural language, and bounds the window', () => {
  const now = Date.UTC(2026, 10, 1, 12, 0, 0)
  const nowSec = now / 1000
  assert.deepEqual(normalizeReminderTime('2026-11-02T12:00:00Z', now), { value: nowSec + 86400 })
  assert.deepEqual(normalizeReminderTime(nowSec + 600, now), { value: nowSec + 600 })
  assert.deepEqual(normalizeReminderTime(900, now), { value: nowSec + 900 })
  assert.deepEqual(normalizeReminderTime(String(nowSec + 60), now), { value: nowSec + 60 })
  assert.deepEqual(normalizeReminderTime('in 15 minutes', now), { value: 'in 15 minutes', natural: true })
  assert.equal(normalizeReminderTime('2020-01-01T00:00:00Z', now).error, 'time-must-be-in-the-future')
  assert.equal(normalizeReminderTime('2030-01-01T00:00:00Z', now).error, 'time-too-far-in-the-future-max-365-days')
  assert.equal(normalizeReminderTime('2026-99-99T00:00:00Z', now).error, 'invalid-time')
  assert.equal(normalizeReminderTime(-5, now).error, 'invalid-time')
  assert.equal(normalizeReminderTime('', now).error, 'time-required')
})

test('addReminder: own reminders go straight through; another user needs confirm:true; dry-run previews either', async () => {
  const { calls, slackCall } = fakeSlack()
  await addReminder({ token: 'xoxp', text: 'ship it', time: 'in 1 hour', slackCall })
  assert.deepEqual(calls[0], { method: 'reminders.add', token: 'xoxp', body: { text: 'ship it', time: 'in 1 hour' } })

  const refused = await addReminder({ token: 'xoxp', text: 'review', time: 'tomorrow at 9am', userId: 'U9', slackCall })
  assert.equal(refused.error, 'confirm-required-to-remind-another-user')
  assert.equal(refused.userId, 'U9')
  assert.equal(calls.length, 1)

  const preview = await addReminder({ token: 'xoxp', text: 'review', time: 'tomorrow at 9am', userId: 'U9', dryRun: true, slackCall })
  assert.equal(preview.request.body.user, 'U9')
  assert.equal(calls.length, 1)

  await addReminder({ token: 'xoxp', text: 'review', time: 'tomorrow at 9am', userId: 'U9', confirm: true, slackCall })
  assert.equal(calls[1].body.user, 'U9')
  assert.equal((await addReminder({ token: 'xoxp', time: 'in 1 hour', slackCall })).error, 'text-required')
  assert.equal((await addReminder({ text: 'x', time: 'in 1 hour', slackCall })).error, 'no-token')
})

test('reminder list / complete / delete map to the right Slack methods', async () => {
  const { calls, slackCall } = fakeSlack()
  await listReminders({ token: 't', slackCall })
  await completeReminder({ token: 't', reminderId: 'Rm1', slackCall })
  await deleteReminder({ token: 't', reminderId: 'Rm1', slackCall })
  assert.deepEqual(calls.map(call => [call.method, call.body]), [['reminders.list', {}], ['reminders.complete', { reminder: 'Rm1' }], ['reminders.delete', { reminder: 'Rm1' }]])
  assert.equal((await completeReminder({ token: 't', slackCall })).error, 'reminderId-required')
})

// ---- user groups ----

const GROUPS = [
  { id: 'S1', handle: 'reviewers', name: 'Code Reviewers', user_count: 4 },
  { id: 'S2', handle: 'oncall', name: 'On Call', user_count: 2, description: 'pager' },
  { id: 'S3', handle: 'reviewers-eu', name: 'EU Reviewers', user_count: 1 },
]

test('lookupUserGroup: exact handle/name/id match returns the mention string; echoes tokenSource', async () => {
  const { slackCall } = fakeSlack({ 'usergroups.list': () => ({ ok: true, usergroups: GROUPS }) })
  const byHandle = await lookupUserGroup({ token: 't', tokenSource: 'user', query: '@Reviewers', slackCall })
  assert.equal(byHandle.exact, true)
  assert.deepEqual(byHandle.usergroups.map(group => [group.id, group.mention]), [['S1', '<!subteam^S1>']])
  assert.equal(byHandle.tokenSource, 'user')
  assert.equal((await lookupUserGroup({ token: 't', query: 'On Call', slackCall })).usergroups[0].id, 'S2')
  assert.equal((await lookupUserGroup({ token: 't', query: 's3', slackCall })).usergroups[0].id, 'S3')
})

test('lookupUserGroup: partial matches list candidates, no match errors, ambiguity refuses, member expansion is bounded', async () => {
  const dupes = [...GROUPS, { id: 'S4', handle: 'dup', name: 'reviewers', user_count: 1 }]
  const { calls, slackCall } = fakeSlack({
    'usergroups.list': () => ({ ok: true, usergroups: dupes }),
    'usergroups.users.list': body => ({ ok: true, users: [`U-${body.usergroup}`] }),
  })
  const ambiguous = await lookupUserGroup({ token: 't', tokenSource: 'bot', query: 'reviewers', slackCall })
  assert.equal(ambiguous.error, 'ambiguous-usergroup')
  assert.equal(ambiguous.matches.length, 2)
  const partial = await lookupUserGroup({ token: 't', query: 'eu', slackCall })
  assert.equal(partial.exact, false)
  assert.deepEqual(partial.usergroups.map(group => group.id), ['S3'])
  assert.equal((await lookupUserGroup({ token: 't', query: 'zzz', slackCall })).error, 'usergroup-not-found')
  const withMembers = await lookupUserGroup({ token: 't', query: 'oncall', includeMembers: true, slackCall })
  assert.deepEqual(withMembers.usergroups[0].members, ['U-S2'])
  assert.equal((await lookupUserGroup({ query: 'x', slackCall })).error, 'no-token')

  const many = fakeSlack({ 'usergroups.list': () => ({ ok: true, usergroups: Array.from({ length: 6 }, (_, i) => ({ id: `S${i}`, handle: `g${i}`, name: `G ${i}` })) }) })
  assert.equal((await lookupUserGroup({ token: 't', includeMembers: true, slackCall: many.slackCall })).error, 'too-many-groups-to-expand-members-narrow-the-query')
  assert.equal(many.calls.filter(call => call.method === 'usergroups.users.list').length, 0, 'no member lookups when refused')
})

// ---- status / presence / dnd ----

test('setStatus builds the profile JSON, normalizes the emoji, computes expiry, and can clear', async () => {
  const { calls, slackCall } = fakeSlack()
  const now = 1_800_000_000_000
  await setStatus({ token: 't', text: 'Heads down', emoji: 'headphones', expiresInMinutes: 60, now, slackCall })
  assert.deepEqual(JSON.parse(calls[0].body.profile), { status_text: 'Heads down', status_emoji: ':headphones:', status_expiration: 1_800_003_600 })
  await setStatus({ token: 't', clear: true, slackCall })
  assert.deepEqual(JSON.parse(calls[1].body.profile), { status_text: '', status_emoji: '', status_expiration: 0 })
  assert.equal((await setStatus({ token: 't', slackCall })).error, 'text-emoji-or-clear-required')
  assert.equal((await setStatus({ token: 't', text: 'x'.repeat(101), slackCall })).error, 'text-too-long-max-100')
  assert.equal((await setStatus({ token: 't', text: 'x', expiresInMinutes: -1, slackCall })).error, 'expiresInMinutes-must-be-positive')
  assert.equal((await setStatus({ text: 'x', dryRun: true, slackCall })).dryRun, true)
})

test('setPresence and manageDnd validate input and map to the right methods', async () => {
  const { calls, slackCall } = fakeSlack()
  assert.equal((await setPresence({ token: 't', presence: 'busy', slackCall })).error, 'presence-must-be-auto-or-away')
  await setPresence({ token: 't', presence: 'away', slackCall })
  assert.equal((await manageDnd({ token: 't', action: 'pause', slackCall })).error, 'action-must-be-snooze-end-or-info')
  assert.equal((await manageDnd({ token: 't', action: 'snooze', slackCall })).error, 'minutes-must-be-between-1-and-1440')
  assert.equal((await manageDnd({ token: 't', action: 'snooze', minutes: 5000, slackCall })).error, 'minutes-must-be-between-1-and-1440')
  await manageDnd({ token: 't', action: 'snooze', minutes: 30.7, slackCall })
  await manageDnd({ token: 't', action: 'end', slackCall })
  await manageDnd({ token: 't', action: 'info', userId: 'U1', slackCall })
  assert.deepEqual(calls.map(call => [call.method, call.body]), [
    ['users.setPresence', { presence: 'away' }],
    ['dnd.setSnooze', { num_minutes: '30' }],
    ['dnd.endSnooze', {}],
    ['dnd.info', { user: 'U1' }],
  ])
  assert.equal((await manageDnd({ action: 'end', dryRun: true, slackCall })).request.method, 'dnd.endSnooze')
})
