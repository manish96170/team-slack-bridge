import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSlackLink, applyLinkToArgs } from '../core/links.js'
import { withLinkSupport, LINK_SUPPORT } from '../mcp/links.js'
import { validateArguments } from '../mcp/validation.js'
import { schemas } from '../mcp/schema.js'
import { tools } from '../mcp/tools.local.js'
import { tools as remoteTools } from '../mcp/tools.remote.js'
import { applyLinkFlag } from '../cli/lib/args.js'

const MSG = 'https://example.slack.com/archives/C0123ABCD/p1793337025613279'

test('parseSlackLink splits a permalink into channel, dotted ts and thread root', () => {
  assert.deepEqual(parseSlackLink(MSG), {
    ok: true,
    workspaceDomain: 'example.slack.com',
    channel: 'C0123ABCD',
    ts: '1793337025.613279',
    threadTs: '1793337025.613279',
    isThreadReply: false,
  })
})

test('parseSlackLink reports the thread root for a reply link and tolerates mrkdwn wrapping', () => {
  const reply = parseSlackLink(`<${MSG.replace('p1793337025613279', 'p1793339563582009')}?thread_ts=1793337025.613279&cid=C0123ABCD|label>`)
  assert.equal(reply.ok, true)
  assert.equal(reply.ts, '1793339563.582009')
  assert.equal(reply.threadTs, '1793337025.613279')
  assert.equal(reply.isThreadReply, true)
})

test('parseSlackLink accepts a channel-only link (no message) and rejects everything else', () => {
  const channelOnly = parseSlackLink('https://example.slack.com/archives/C0123ABCD')
  assert.equal(channelOnly.ok, true)
  assert.equal(channelOnly.ts, undefined)
  assert.equal(parseSlackLink('https://evil.example.com/archives/C1/p1793337025613279').error, 'not-a-slack-link')
  assert.equal(parseSlackLink('http://example.slack.com/archives/C1/p1793337025613279').error, 'not-a-slack-link')
  assert.equal(parseSlackLink('https://slack.com.evil.io/archives/C1/p1793337025613279').error, 'not-a-slack-link')
  assert.equal(parseSlackLink('https://example.slack.com/team/U123').error, 'unsupported-slack-link-shape')
  assert.equal(parseSlackLink('not a url').error, 'invalid-slack-link')
  assert.equal(parseSlackLink('').error, 'link-required')
  assert.equal(parseSlackLink(undefined).error, 'link-required')
})

test('applyLinkToArgs fills only missing arguments: an explicit channel/ts wins over the link', () => {
  const filled = applyLinkToArgs({ link: MSG, text: 'hi' }, { channel: 'channel', threadTs: 'thread' })
  assert.deepEqual(filled.args, { text: 'hi', channel: 'C0123ABCD', threadTs: '1793337025.613279' })
  const explicit = applyLinkToArgs({ link: MSG, channel: 'C9EXPLICIT' }, { channel: 'channel', ts: 'ts' })
  assert.equal(explicit.args.channel, 'C9EXPLICIT')
  assert.equal(explicit.args.ts, '1793337025.613279')
  assert.equal(applyLinkToArgs({ text: 'no link' }, { channel: 'channel' }).args.text, 'no link')
})

test('applyLinkToArgs: a required message argument errors on a channel-only link, an optional one is skipped', () => {
  const channelOnly = 'https://example.slack.com/archives/C0123ABCD'
  assert.equal(applyLinkToArgs({ link: channelOnly }, { channel: 'channel', ts: 'ts' }).error, 'link-has-no-message-for-ts')
  const soft = applyLinkToArgs({ link: channelOnly }, { channel: 'channel', ts: '?ts' })
  assert.equal(soft.ok, true)
  assert.deepEqual(soft.args, { channel: 'C0123ABCD' })
  assert.equal(applyLinkToArgs({ link: 'nope' }, { channel: 'channel' }).ok, false)
})

test('withLinkSupport relaxes required channel/threadTs, adds link, and keeps the base schema untouched', () => {
  const wrapped = withLinkSupport({ inputSchema: schemas.slack_reply, handler: async () => ({ ok: true }) }, LINK_SUPPORT.slack_reply)
  assert.deepEqual(wrapped.inputSchema.required, ['text'])
  assert.ok(wrapped.inputSchema.properties.link)
  assert.deepEqual(schemas.slack_reply.required, ['channel', 'threadTs', 'text'], 'base schema must not be mutated')
  assert.equal(schemas.slack_reply.properties.link, undefined)
})

test('link-enabled tools validate: either the explicit arguments or a link satisfy channel/threadTs', () => {
  const schema = tools.slack_reply.inputSchema
  assert.equal(validateArguments(schema, { text: 'hi' }), 'missing required argument: channel (or pass link)')
  assert.equal(validateArguments(schema, { text: 'hi', channel: 'C1' }), 'missing required argument: threadTs (or pass link)')
  assert.equal(validateArguments(schema, { text: 'hi', channel: 'C1', threadTs: '1.1' }), null)
  assert.equal(validateArguments(schema, { text: 'hi', link: MSG }), null)
  assert.equal(validateArguments(schema, { text: 'hi', link: MSG, bogus: 1 }), 'unknown argument: bogus')
})

test('the handler receives channel/threadTs resolved from the link and never sees `link` itself', async () => {
  let seen
  const wrapped = withLinkSupport({ inputSchema: schemas.slack_reply, handler: async args => { seen = args; return { ok: true } } }, LINK_SUPPORT.slack_reply)
  await wrapped.handler({ link: MSG, text: 'hi', dryRun: true }, {})
  assert.deepEqual(seen, { text: 'hi', dryRun: true, channel: 'C0123ABCD', threadTs: '1793337025.613279' })
  const bad = await wrapped.handler({ link: 'https://evil.example.com/archives/C1/p1793337025613279', text: 'hi' }, {})
  assert.deepEqual(bad, { ok: false, error: 'not-a-slack-link', retryable: false })
})

test('end to end through the real registry: a dry-run reply built from a permalink targets the right thread', async () => {
  const result = await tools.slack_reply.handler({ link: MSG, text: 'hello', dryRun: true }, { env: {}, config: {}, dbPath: undefined })
  assert.equal(result.ok, true)
  assert.equal(result.request.body.channel, 'C0123ABCD')
  assert.equal(result.request.body.thread_ts, '1793337025.613279')
})

test('every tool named in LINK_SUPPORT exists locally, and the remote profile is unchanged by link support', () => {
  for (const name of Object.keys(LINK_SUPPORT)) assert.ok(tools[name], `${name} missing from the local registry`)
  for (const tool of Object.values(remoteTools)) assert.equal(tool.inputSchema.properties.link, undefined, `${tool.name} must not advertise link remotely`)
})

test('slack_resolve_link tool parses offline', async () => {
  const result = await tools.slack_resolve_link.handler({ link: MSG }, {})
  assert.equal(result.channel, 'C0123ABCD')
})

test('applyLinkFlag fills CLI flags from --link without overriding explicit ones', () => {
  const flags = { link: MSG, channel: undefined, ts: undefined }
  applyLinkFlag(flags, { channel: 'channel', ts: 'ts' }, { exit: false })
  assert.equal(flags.channel, 'C0123ABCD')
  assert.equal(flags.ts, '1793337025.613279')
  const explicit = { link: MSG, channel: 'C9' }
  applyLinkFlag(explicit, { channel: 'channel', ts: 'ts' }, { exit: false })
  assert.equal(explicit.channel, 'C9')
})
