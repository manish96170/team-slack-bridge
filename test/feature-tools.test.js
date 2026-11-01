import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tools } from '../mcp/tools.local.js'
import { featureTools } from '../mcp/tools.features.js'
import { featureSchemas } from '../mcp/schema.features.js'
import { tools as remoteTools } from '../mcp/tools.remote.js'
import { validateArguments } from '../mcp/validation.js'
import { loadConfig } from '../core/identity.js'

const FEATURE_NAMES = [
  'slack_resolve_link', 'slack_call', 'slack_huddle_status', 'slack_canvas', 'slack_pin', 'slack_bookmark',
  'slack_reminder', 'slack_usergroup_lookup', 'slack_file', 'slack_set_status', 'slack_set_presence', 'slack_dnd',
]
const manifest = JSON.parse(readFileSync(new URL('../config/slack-app-manifest.template.json', import.meta.url), 'utf8'))
const userScopes = readFileSync(new URL('../get-user-token.js', import.meta.url), 'utf8').match(/USER_SCOPES = '([^']+)'/)[1].split(',')

test('every feature tool is registered locally, schema-backed, and absent from the remote/hosted profile', () => {
  assert.deepEqual(Object.keys(featureTools).sort(), [...FEATURE_NAMES].sort())
  for (const name of FEATURE_NAMES) {
    assert.ok(tools[name], `${name} not in the local registry`)
    assert.equal(tools[name].name, name)
    assert.equal(tools[name].inputSchema.type, 'object')
    assert.equal(tools[name].inputSchema.additionalProperties, false, `${name} must reject unknown arguments`)
    assert.ok(featureSchemas[name], `${name} has no schema`)
    assert.equal(remoteTools[name], undefined, `${name} must not be remote`)
  }
})

test('the feature schemas never carry spoofable identity fields', () => {
  for (const [name, schema] of Object.entries(featureSchemas)) {
    for (const forbidden of ['username', 'icon_url', 'icon_emoji', 'viaBot', 'anonymousMessage']) {
      assert.equal(schema.properties[forbidden], undefined, `${name} must not accept ${forbidden}`)
    }
  }
})

test('feature tools validate action enums and required arguments like the rest of the registry', () => {
  assert.equal(validateArguments(tools.slack_pin.inputSchema, { action: 'explode', channel: 'C1' }), 'action must be one of: add, remove, list')
  assert.equal(validateArguments(tools.slack_canvas.inputSchema, {}), 'missing required argument: action')
  assert.equal(validateArguments(tools.slack_set_presence.inputSchema, { presence: 'busy' }), 'presence must be one of: auto, away')
  assert.equal(validateArguments(tools.slack_reminder.inputSchema, { action: 'add', text: 'x', time: 'in 5 minutes' }), null)
  assert.equal(validateArguments(tools.slack_reminder.inputSchema, { action: 'add', text: 'x', time: 600 }), null)
  assert.equal(validateArguments(tools.slack_reminder.inputSchema, { action: 'add', text: 'x', time: true }), 'time must be string|number')
  assert.equal(validateArguments(tools.slack_dnd.inputSchema, { action: 'snooze', minutes: 'soon' }), 'minutes must be number')
})

test('write tools use the human token only: no user token means a clear refusal, never a bot fallback', async () => {
  const botOnly = { env: { SLACK_BOT_TOKEN: 'xoxb-bot' }, config: {}, dbPath: undefined }
  const cases = [
    ['slack_call', { action: 'start', channel: 'C1', title: 'x' }],
    ['slack_canvas', { action: 'create', title: 'x' }],
    ['slack_pin', { action: 'add', channel: 'C1', ts: '1.1' }],
    ['slack_bookmark', { action: 'list', channel: 'C1' }],
    ['slack_reminder', { action: 'list' }],
    ['slack_set_status', { text: 'x' }],
    ['slack_set_presence', { presence: 'away' }],
    ['slack_dnd', { action: 'info' }],
  ]
  for (const [name, args] of cases) {
    const result = await tools[name].handler(args, botOnly)
    assert.deepEqual(result, { ok: false, error: 'user-token-required', retryable: false }, name)
  }
})

test('dryRun works without any token and sends nothing', async () => {
  const none = { env: {}, config: {}, dbPath: undefined }
  const pin = await tools.slack_pin.handler({ action: 'add', channel: 'C1', ts: '1.1', dryRun: true }, none)
  assert.equal(pin.request.method, 'pins.add')
  const call = await tools.slack_call.handler({ action: 'start', channel: 'C1', title: 'Sync', dryRun: true }, none)
  assert.match(call.joinUrl, /^https:\/\/meet\.jit\.si\/sync-/)
  const status = await tools.slack_set_status.handler({ text: 'Heads down', emoji: 'headphones', dryRun: true }, none)
  assert.equal(status.request.body.profile.status_emoji, ':headphones:')
})

test('action-based tools return a structured error for an action the schema should have blocked', async () => {
  const ctx = { env: { SLACK_USER_TOKEN: 'xoxp-human' }, config: {}, dbPath: undefined }
  for (const name of ['slack_call', 'slack_canvas', 'slack_pin', 'slack_bookmark', 'slack_reminder']) {
    const result = await tools[name].handler({ action: 'nonsense', channel: 'C1' }, ctx)
    assert.equal(result.ok, false)
    assert.match(result.error, /^action-must-be-one-of-/)
  }
})

test('destructive or other-user-affecting actions are gated on confirm:true', async () => {
  const ctx = { env: { SLACK_USER_TOKEN: 'xoxp-human' }, config: {}, dbPath: undefined }
  assert.equal((await tools.slack_canvas.handler({ action: 'delete', canvasId: 'F1' }, ctx)).error, 'confirm-required-to-delete-canvas')
  assert.equal((await tools.slack_reminder.handler({ action: 'add', text: 'x', time: 'in 5 minutes', userId: 'U2' }, ctx)).error, 'confirm-required-to-remind-another-user')
  assert.equal((await tools.slack_canvas.handler({ action: 'read' }, ctx)).error, 'canvasId-required')
})

test('read tools default to the human token and echo the token source; bot is explicit', async () => {
  // No network: a tokenless call fails before any request, but still reports which identity was selected.
  const result = await tools.slack_file.handler({ action: 'info', fileId: 'F1' }, { env: {}, config: {}, dbPath: undefined })
  assert.equal(result.error, 'no-token')
  assert.equal(result.tokenSource, 'user')
  const bot = await tools.slack_huddle_status.handler({ userIds: ['U1'], tokenSource: 'bot' }, { env: {}, config: {}, dbPath: undefined })
  assert.equal(bot.tokenSource, 'bot')
  assert.equal(bot.error, 'no-token')
  const groups = await tools.slack_usergroup_lookup.handler({ query: 'x' }, { env: {}, config: {}, dbPath: undefined })
  assert.equal(groups.error, 'no-token')
})

test('manifest and user-token OAuth request every scope the feature tools need', () => {
  const required = {
    user: ['calls:read', 'calls:write', 'canvases:read', 'canvases:write', 'pins:read', 'pins:write', 'bookmarks:read', 'bookmarks:write',
      'reminders:read', 'reminders:write', 'usergroups:read', 'files:read', 'users.profile:write', 'users:write', 'dnd:read', 'dnd:write', 'users:read'],
    bot: ['files:read', 'usergroups:read', 'users:read'],
  }
  for (const scope of required.user) {
    assert.ok(manifest.oauth_config.scopes.user.includes(scope), `manifest user ${scope}`)
    assert.ok(userScopes.includes(scope), `get-user-token ${scope}`)
  }
  for (const scope of required.bot) assert.ok(manifest.oauth_config.scopes.bot.includes(scope), `manifest bot ${scope}`)
  assert.ok(manifest.settings.event_subscriptions.bot_events.includes('user_huddle_changed'))
  assert.equal(new Set(userScopes).size, userScopes.length, 'no duplicate user scopes')
  assert.equal(new Set(manifest.oauth_config.scopes.user).size, manifest.oauth_config.scopes.user.length)
})

test('config: huddleWatch is off by default and calls.jitsiBaseUrl has a default; both are read from slack-config.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-config-'))
  try {
    const defaults = loadConfig(join(dir, 'missing.json'))
    assert.deepEqual(defaults.huddleWatch, { enabled: false, userIds: [], promptRecap: false })
    assert.equal(defaults.calls.jitsiBaseUrl, 'https://meet.jit.si')

    const path = join(dir, 'slack-config.json')
    writeFileSync(path, JSON.stringify({ calls: { jitsiBaseUrl: 'https://jitsi.internal.example' }, huddleWatch: { enabled: true, userIds: ['U1'], promptRecap: true } }))
    const loaded = loadConfig(path)
    assert.deepEqual(loaded.huddleWatch, { enabled: true, userIds: ['U1'], promptRecap: true })
    assert.equal(loaded.calls.jitsiBaseUrl, 'https://jitsi.internal.example')

    writeFileSync(path, JSON.stringify({ huddleWatch: { enabled: 'yes' }, calls: { jitsiBaseUrl: 42 } }))
    const sloppy = loadConfig(path)
    assert.equal(sloppy.huddleWatch.enabled, false, 'only a literal true enables huddle watching')
    assert.equal(sloppy.calls.jitsiBaseUrl, 'https://meet.jit.si')

    const example = loadConfig(new URL('../config/slack-config.example.json', import.meta.url).pathname)
    assert.equal(example.huddleWatch.enabled, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
