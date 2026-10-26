import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tools } from '../mcp/tools.local.js'

// PLAN D60: slack_react/slack_unreact/slack_update_message/slack_delete_message
// now default (viaBot:false) to the locally authorized human (SLACK_USER_TOKEN),
// matching D47's slack_post/slack_reply/slack_dm precedent. viaBot:true opts
// back into the shared bot token. The _as_user tools remain as explicit aliases
// for the (now default) behavior, same posture D47 left slack_post_as_user/
// slack_dm_as_user in.

test('slack_react defaults to the user token and refuses cleanly with only a bot token configured', async () => {
  const result = await tools.slack_react.handler(
    { channel: '#x', ts: '1.1', emoji: 'eyes' },
    { env: { SLACK_BOT_TOKEN: 'xoxb-x' }, config: {} },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-token')
})

test('slack_react viaBot:true uses the bot token and refuses cleanly with only a user token configured', async () => {
  const result = await tools.slack_react.handler(
    { channel: '#x', ts: '1.1', emoji: 'eyes', viaBot: true },
    { env: { SLACK_USER_TOKEN: 'xoxp-x' }, config: {} },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-token')
})

test('slack_unreact defaults to the user token and refuses cleanly with only a bot token configured', async () => {
  const result = await tools.slack_unreact.handler(
    { channel: '#x', ts: '1.1', emoji: 'eyes' },
    { env: { SLACK_BOT_TOKEN: 'xoxb-x' }, config: {} },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-token')
})

test('slack_unreact viaBot:true uses the bot token and refuses cleanly with only a user token configured', async () => {
  const result = await tools.slack_unreact.handler(
    { channel: '#x', ts: '1.1', emoji: 'eyes', viaBot: true },
    { env: { SLACK_USER_TOKEN: 'xoxp-x' }, config: {} },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-token')
})

test('slack_update_message defaults to the user token and refuses cleanly with only a bot token configured', async () => {
  const result = await tools.slack_update_message.handler(
    { channel: '#x', ts: '1.1', text: 'new' },
    { env: { SLACK_BOT_TOKEN: 'xoxb-x' }, config: {} },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-token')
})

test('slack_update_message viaBot:true uses the bot token, refuses cleanly with only a user token configured', async () => {
  const result = await tools.slack_update_message.handler(
    { channel: '#x', ts: '1.1', text: 'new', viaBot: true },
    { env: { SLACK_USER_TOKEN: 'xoxp-x' }, config: {} },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-token')
})

test('slack_delete_message defaults to the user token and refuses cleanly with only a bot token configured', async () => {
  const result = await tools.slack_delete_message.handler(
    { channel: '#x', ts: '1.1' },
    { env: { SLACK_BOT_TOKEN: 'xoxb-x' }, config: {} },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-token')
})

test('slack_delete_message viaBot:true uses the bot token, refuses cleanly with only a user token configured', async () => {
  const result = await tools.slack_delete_message.handler(
    { channel: '#x', ts: '1.1', viaBot: true },
    { env: { SLACK_USER_TOKEN: 'xoxp-x' }, config: {} },
  )
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-token')
})

test('slack_react_as_user and slack_unreact_as_user remain explicit aliases for the (now default) behavior', async () => {
  const react = await tools.slack_react_as_user.handler({ channel: '#x', ts: '1.1', emoji: 'eyes', dryRun: true }, { env: {}, config: {} })
  const unreact = await tools.slack_unreact_as_user.handler({ channel: '#x', ts: '1.1', emoji: 'eyes', dryRun: true }, { env: {}, config: {} })
  assert.equal(react.ok, true)
  assert.equal(unreact.ok, true)
})

test('slack_update_message_as_user and slack_delete_message_as_user remain explicit aliases for the (now default) behavior', async () => {
  const update = await tools.slack_update_message_as_user.handler({ channel: '#x', ts: '1.1', text: 'new', dryRun: true }, { env: {}, config: {} })
  const del = await tools.slack_delete_message_as_user.handler({ channel: '#x', ts: '1.1', dryRun: true }, { env: {}, config: {} })
  assert.equal(update.ok, true)
  assert.equal(del.ok, true)
})

// mcp/tools.remote.js is deliberately untouched by this decision -- the
// hosted profile has no user tokens at all, by design (D20), so there is
// nothing to default away from there.
test('mcp/tools.remote.js is unaffected -- its react/update/delete still use the bot token unconditionally', async () => {
  const { tools: remoteTools } = await import('../mcp/tools.remote.js')
  const result = await remoteTools.slack_react.handler(
    { channel: '#x', ts: '1.1', emoji: 'eyes' },
    { env: { SLACK_USER_TOKEN: 'xoxp-should-never-be-used' }, config: {} },
  )
  // No bot token configured either -> must fail with no-token, proving it
  // never reached for (or fell back to) the user token above.
  assert.equal(result.ok, false)
  assert.equal(result.error, 'no-token')
})
