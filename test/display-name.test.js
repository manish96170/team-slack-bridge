import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveUser, resolveMentions } from '../core/identity.js'

const makeConfig = users => ({
  users,
  watchedChannels: [],
  owner: {},
  dmAllowlist: [],
  remote: { postableChannels: [], readableChannels: [] },
})

const team = () => makeConfig([
  { name: 'Pulkit Jain', slackHandle: '@pulkit.jain', displayName: '@PJ', slackUserId: 'U_PJ' },
  { name: 'Shuhao Pang', slackHandle: '@shuhao.pang', displayName: '@portia.p', slackUserId: 'U_PORTIA' },
])

test('resolveUser resolves a configured displayName, case-insensitively and with or without "@"', () => {
  const config = team()
  assert.deepEqual(resolveUser('@PJ', config), { ok: true, userId: 'U_PJ', name: 'Pulkit Jain' })
  assert.deepEqual(resolveUser('pj', config), { ok: true, userId: 'U_PJ', name: 'Pulkit Jain' })
  assert.deepEqual(resolveUser('Portia.P', config), { ok: true, userId: 'U_PORTIA', name: 'Shuhao Pang' })
})

test('resolveUser still resolves name and slackHandle when a displayName is also configured', () => {
  const config = team()
  assert.equal(resolveUser('Shuhao Pang', config).userId, 'U_PORTIA')
  assert.equal(resolveUser('@shuhao.pang', config).userId, 'U_PORTIA')
  assert.equal(resolveUser('U_PJ', config).userId, 'U_PJ')
})

test('a name/slackHandle match wins over another user\'s identical displayName', () => {
  const config = makeConfig([
    { name: 'Display Holder', slackHandle: '@display.holder', displayName: '@pk', slackUserId: 'U_DISPLAY' },
    { name: 'Handle Owner', slackHandle: '@pk', slackUserId: 'U_HANDLE' },
  ])
  assert.equal(resolveUser('@pk', config).userId, 'U_HANDLE')
})

test('a displayName shared by two configured users is refused as ambiguous, never picked', () => {
  const config = makeConfig([
    { name: 'Alex One', slackHandle: '@alex.one', displayName: '@alex', slackUserId: 'U_ONE' },
    { name: 'Alex Two', slackHandle: '@alex.two', displayName: '@Alex', slackUserId: 'U_TWO' },
  ])
  const result = resolveUser('@alex', config)
  assert.equal(result.ok, false)
  assert.equal(result.error, 'ambiguous-user')
  assert.deepEqual(result.matches.map(match => match.userId).sort(), ['U_ONE', 'U_TWO'])
})

test('resolveMentions turns a configured @displayName into a real mention', () => {
  assert.equal(resolveMentions('Reviewer: @PJ @portia.p', team()), 'Reviewer: <@U_PJ> <@U_PORTIA>')
})

test('resolveMentions leaves an ambiguous @displayName exactly as typed', () => {
  const config = makeConfig([
    { name: 'Alex One', slackHandle: '@alex.one', displayName: '@alex', slackUserId: 'U_ONE' },
    { name: 'Alex Two', slackHandle: '@alex.two', displayName: '@alex', slackUserId: 'U_TWO' },
  ])
  assert.equal(resolveMentions('cc @alex', config), 'cc @alex')
})

test('users without a displayName behave exactly as before', () => {
  const config = makeConfig([{ name: 'PJ', slackHandle: '@pj', slackUserId: 'U_PJ' }])
  assert.equal(resolveUser('@pj', config).userId, 'U_PJ')
  assert.equal(resolveUser('@nobody', config).error, 'user-not-configured')
})
