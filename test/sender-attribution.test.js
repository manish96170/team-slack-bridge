import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSenderInfo, withSenderAttribution, isAuthorizedSender, resolveAnonymousMessage } from '../core/sender.js'
import { recordLocalAudit, queryLocalAudit } from '../core/local-audit.js'
import {
  isTrackingEnabled,
  echoBotSendToSender,
  recordBotSendTracking,
  findBotSendTracking,
  removeBotSendTracking,
  propagateUpdateToTracking,
  propagateDeleteToTracking,
} from '../core/tracking.js'
import { tools } from '../mcp/tools.local.js'

const configWithOwner = {
  owner: { slackUserId: 'U0OWNER' },
  users: [{ name: 'Manish Sharma', slackHandle: '@manish.sharma', slackUserId: 'U0OWNER' }],
}

test('getSenderInfo resolves handle/name from users against owner.slackUserId', () => {
  assert.deepEqual(getSenderInfo(configWithOwner), { slackUserId: 'U0OWNER', slackHandle: '@manish.sharma', name: 'Manish Sharma' })
})

test('getSenderInfo returns nulls when no owner is configured', () => {
  assert.deepEqual(getSenderInfo({}), { slackUserId: null, slackHandle: null, name: null })
})

test('withSenderAttribution appends a mention, handle, and a plain-text memberId', () => {
  const out = withSenderAttribution('hello', configWithOwner)
  assert.ok(out.startsWith('hello\n\n'))
  assert.match(out, /<@U0OWNER>/)
  assert.match(out, /@manish\.sharma/)
  assert.match(out, /memberId: U0OWNER/)
})

test('withSenderAttribution degrades gracefully with no configured owner', () => {
  const out = withSenderAttribution('hello', {})
  assert.match(out, /no owner\.slackUserId configured/)
})

test('local_audit round-trips through recordLocalAudit/queryLocalAudit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-local-audit-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    recordLocalAudit({
      dbPath,
      sender: { slackUserId: 'U0OWNER', slackHandle: '@manish.sharma', name: 'Manish Sharma' },
      tool: 'slack_post',
      viaBot: true,
      ok: true,
      channel: '#eng',
      ts: '1.1',
    })
    const rows = queryLocalAudit({ dbPath, limit: 10 })
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sender_user_id, 'U0OWNER')
    assert.equal(rows[0].sender_handle, '@manish.sharma')
    assert.equal(rows[0].tool, 'slack_post')
    assert.equal(rows[0].via_bot, 1)
    assert.equal(rows[0].channel, '#eng')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('slack_post defaults to as-user and refuses without a user token', async () => {
  const result = await tools.slack_post.handler({ channel: '#x', text: 'hi' }, { env: {}, config: {} })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'user-token-required-pass-viaBot-true-to-send-as-the-bot-instead')
})

test('slack_post dry-run as-user sends the text unmodified', async () => {
  const result = await tools.slack_post.handler({ channel: '#x', text: 'hi', dryRun: true }, { env: {}, config: {} })
  assert.equal(result.ok, true)
  assert.equal(result.request.body.text, 'hi')
})

test('slack_post dry-run viaBot:true appends attribution and never touches local_audit on a dry run', async () => {
  const result = await tools.slack_post.handler({ channel: '#x', text: 'hi', viaBot: true, dryRun: true }, { env: {}, config: configWithOwner })
  assert.equal(result.ok, true)
  assert.match(result.request.body.text, /sent via bot by/)
  assert.match(result.request.body.text, /memberId: U0OWNER/)
})

test('slack_post viaBot:true without dry-run refuses when SLACK_BOT_TOKEN is missing', async () => {
  const result = await tools.slack_post.handler({ channel: '#x', text: 'hi', viaBot: true }, { env: {}, config: configWithOwner })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bot-token-required')
})

test('slack_dm defaults to as-user (dm() reports user-token-required)', async () => {
  const result = await tools.slack_dm.handler({ userId: 'U123', text: 'hi' }, { env: {}, config: {} })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'user-token-required')
})

test('slack_dm viaBot:true without an identified sender is refused unless anonymousMessage:true', async () => {
  const refused = await tools.slack_dm.handler({ userId: 'U123', text: 'hi', viaBot: true }, { env: {}, config: {} })
  assert.equal(refused.ok, false)
  assert.equal(refused.error, 'not-authorized-to-send-as-bot-pass-anonymousMessage-true-to-send-anonymously')

  const allowed = await tools.slack_dm.handler({ userId: 'U123', text: 'hi', viaBot: true, anonymousMessage: true }, { env: {}, config: {} })
  assert.equal(allowed.ok, false)
  assert.equal(allowed.error, 'bot-token-required') // past the gate, still needs a real token
})

test('slack_dm viaBot:true with an identified sender requires the bot token (dm() reports bot-token-required)', async () => {
  const result = await tools.slack_dm.handler({ userId: 'U123', text: 'hi', viaBot: true }, { env: {}, config: configWithOwner })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bot-token-required')
})

test('slack_post viaBot:true without an identified sender is refused unless anonymousMessage:true', async () => {
  const refused = await tools.slack_post.handler({ channel: '#x', text: 'hi', viaBot: true }, { env: {}, config: {} })
  assert.equal(refused.ok, false)
  assert.equal(refused.error, 'not-authorized-to-send-as-bot-pass-anonymousMessage-true-to-send-anonymously')

  const allowed = await tools.slack_post.handler({ channel: '#x', text: 'hi', viaBot: true, anonymousMessage: true, dryRun: true }, { env: {}, config: {} })
  assert.equal(allowed.ok, true)
  assert.match(allowed.request.body.text, /sender withheld — anonymousMessage:true/)
})

test('slack_post viaBot:true + anonymousMessage:true omits identity from the public text even when the sender IS identified', async () => {
  const result = await tools.slack_post.handler({ channel: '#x', text: 'hi', viaBot: true, anonymousMessage: true, dryRun: true }, { env: {}, config: configWithOwner })
  assert.equal(result.ok, true)
  assert.match(result.request.body.text, /sender withheld/)
  assert.doesNotMatch(result.request.body.text, /U0OWNER/)
})

test('slack_delete_message_as_user requires a user token', async () => {
  const result = await tools.slack_delete_message_as_user.handler({ channel: '#x', ts: '1.1' }, { env: {}, config: {} })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-token')
})

test('isAuthorizedSender reflects whether owner.slackUserId is configured', () => {
  assert.equal(isAuthorizedSender(configWithOwner), true)
  assert.equal(isAuthorizedSender({}), false)
})

test('isTrackingEnabled defaults true and respects an explicit false', () => {
  assert.equal(isTrackingEnabled({}), true)
  assert.equal(isTrackingEnabled({ botSendTracking: { enabled: true } }), true)
  assert.equal(isTrackingEnabled({ botSendTracking: { enabled: false } }), false)
})

test('echoBotSendToSender dry-run sends nothing', async () => {
  const result = await echoBotSendToSender({ dryRun: true, kind: 'dm', targetUserId: 'U9', text: 'hi', originalChannel: '#x', originalTs: '1.1' })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
})

test('echoBotSendToSender refuses cleanly with no bot token or no sender', async () => {
  const noToken = await echoBotSendToSender({ senderId: 'U0OWNER', kind: 'dm', targetUserId: 'U9', text: 'hi', originalChannel: '#x', originalTs: '1.1' })
  assert.equal(noToken.ok, false)
  assert.equal(noToken.error, 'tracking-skipped-missing-token-or-sender')

  const noSender = await echoBotSendToSender({ botToken: 'xoxb-fake', kind: 'dm', targetUserId: 'U9', text: 'hi', originalChannel: '#x', originalTs: '1.1' })
  assert.equal(noSender.ok, false)
  assert.equal(noSender.error, 'tracking-skipped-missing-token-or-sender')
})

test('bot_send_tracking round-trips through recordBotSendTracking/findBotSendTracking/removeBotSendTracking', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-tracking-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    recordBotSendTracking({
      dbPath,
      senderId: 'U0OWNER',
      originalChannel: '#eng',
      originalTs: '1.1',
      trackingChannel: 'D123',
      trackingParentTs: '2.1',
      trackingReplyTs: '2.2',
      anonymous: false,
    })
    const found = findBotSendTracking({ dbPath, channel: '#eng', ts: '1.1' })
    assert.equal(found.tracking_channel, 'D123')
    assert.equal(found.tracking_parent_ts, '2.1')
    assert.equal(found.tracking_reply_ts, '2.2')

    assert.equal(findBotSendTracking({ dbPath, channel: '#eng', ts: 'nope' }), null)

    removeBotSendTracking({ dbPath, channel: '#eng', ts: '1.1' })
    assert.equal(findBotSendTracking({ dbPath, channel: '#eng', ts: '1.1' }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('propagateUpdateToTracking is a no-op when there is no tracking copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-tracking-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    const result = await propagateUpdateToTracking({ botToken: 'xoxb-fake', dbPath, config: {}, channel: '#eng', ts: '1.1', text: 'new text' })
    assert.equal(result.ok, true)
    assert.equal(result.skipped, 'no-tracking-copy')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('propagateUpdateToTracking edits only the threaded reply when a tracking copy exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-tracking-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    recordBotSendTracking({ dbPath, senderId: 'U0OWNER', originalChannel: '#eng', originalTs: '1.1', trackingChannel: 'D123', trackingParentTs: '2.1', trackingReplyTs: '2.2' })
    // No real token configured — this confirms it actually attempts the edit
    // (reaching updateMessage's own no-token guard) rather than silently skipping.
    const result = await propagateUpdateToTracking({ botToken: undefined, dbPath, config: {}, channel: '#eng', ts: '1.1', text: 'new text' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-token')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('propagateDeleteToTracking is a no-op when there is no tracking copy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-tracking-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    const result = await propagateDeleteToTracking({ botToken: 'xoxb-fake', dbPath, channel: '#eng', ts: '1.1' })
    assert.equal(result.ok, true)
    assert.equal(result.skipped, 'no-tracking-copy')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('propagateDeleteToTracking attempts to remove the whole tracking DM and drops the row regardless of outcome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-tracking-'))
  const dbPath = join(dir, 'test.sqlite')
  try {
    recordBotSendTracking({ dbPath, senderId: 'U0OWNER', originalChannel: '#eng', originalTs: '1.1', trackingChannel: 'D123', trackingParentTs: '2.1', trackingReplyTs: '2.2' })
    const result = await propagateDeleteToTracking({ botToken: undefined, dbPath, channel: '#eng', ts: '1.1' })
    assert.equal(result.ok, false)
    assert.equal(result.error, 'no-token')
    // the row is dropped even though the underlying Slack calls failed —
    // there is nothing more this install can do about a tracking copy it
    // has no token to reach, and keeping a dangling row forever is worse.
    assert.equal(findBotSendTracking({ dbPath, channel: '#eng', ts: '1.1' }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveAnonymousMessage: an explicit per-call value always wins, true or false', () => {
  assert.equal(resolveAnonymousMessage(true, { botSend: { anonymousMessageDefault: false } }), true)
  assert.equal(resolveAnonymousMessage(false, { botSend: { anonymousMessageDefault: true } }), false)
})

test('resolveAnonymousMessage: an omitted argument falls back to the config default (false unless set)', () => {
  assert.equal(resolveAnonymousMessage(undefined, {}), false)
  assert.equal(resolveAnonymousMessage(undefined, { botSend: { anonymousMessageDefault: true } }), true)
  assert.equal(resolveAnonymousMessage(undefined, { botSend: { anonymousMessageDefault: false } }), false)
})

test('slack_post with no anonymousMessage argument honors an install-wide anonymousMessageDefault:true', async () => {
  const configAnonByDefault = { ...configWithOwner, botSend: { anonymousMessageDefault: true } }
  const result = await tools.slack_post.handler({ channel: '#x', text: 'hi', viaBot: true, dryRun: true }, { env: {}, config: configAnonByDefault })
  assert.equal(result.ok, true)
  assert.match(result.request.body.text, /sender withheld/)
  assert.doesNotMatch(result.request.body.text, /U0OWNER/)
})

test('slack_post explicit anonymousMessage:false overrides an install-wide anonymousMessageDefault:true', async () => {
  const configAnonByDefault = { ...configWithOwner, botSend: { anonymousMessageDefault: true } }
  const result = await tools.slack_post.handler({ channel: '#x', text: 'hi', viaBot: true, anonymousMessage: false, dryRun: true }, { env: {}, config: configAnonByDefault })
  assert.equal(result.ok, true)
  assert.match(result.request.body.text, /sent via bot by/)
  assert.match(result.request.body.text, /U0OWNER/)
})

test('an install with anonymousMessageDefault:true can viaBot-send with no identified sender and no per-call flag', async () => {
  const configAnonByDefault = { botSend: { anonymousMessageDefault: true } }
  const result = await tools.slack_dm.handler({ userId: 'U123', text: 'hi', viaBot: true }, { env: {}, config: configAnonByDefault })
  // Past the authorization gate (config default resolved anonymousMessage
  // to true) — still refused for the unrelated reason of no bot token.
  assert.equal(result.ok, false)
  assert.equal(result.error, 'bot-token-required')
})
