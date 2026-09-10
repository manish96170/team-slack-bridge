import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { Readable } from 'node:stream'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleHttpRequest } from '../listen/http.js'
import { getSlackbotMcpTools } from '../mcp/http.js'
import { complete } from '../core/ledger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..')
const remoteToolNames = [
  'slack_delete_message',
  'slack_doctor',
  'slack_get_thread',
  'slack_post',
  'slack_query_messages',
  'slack_react',
  'slack_reply',
  'slack_resolve_user',
  'slack_update_message',
]
const forbiddenRemoteToolNames = [
  'slack_agent_session_create',
  'slack_ask',
  'slack_delete_scheduled_message',
  'slack_dm',
  'slack_list_scheduled_messages',
  'slack_post_as_user',
  'slack_progress_finish',
  'slack_progress_start',
  'slack_progress_update',
  'slack_publish_home',
  'slack_schedule_message',
  'slack_search',
]
const signingSecret = 'test-signing-secret'

function slackSignature(body, timestamp) {
  return `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${body}`).digest('hex')}`
}

function signedMcpReq(message) {
  const body = JSON.stringify(message)
  const timestamp = String(Math.floor(Date.now() / 1000))
  return req({
    method: 'POST',
    url: '/mcp',
    body,
    headers: {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': slackSignature(body, timestamp),
    },
  })
}

function req({ method, url, body = '', headers = {} }) {
  const stream = Readable.from([body])
  stream.method = method
  stream.url = url
  stream.headers = headers
  return stream
}

function res() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(body = '') {
      this.body = body
    },
  }
}

function tempDbPath() {
  return join(mkdtempSync(join(tmpdir(), 'http-mcp-test-')), 'ledger.sqlite')
}

test('/webhook GET returns a 200 health response', async () => {
  const response = res()
  await handleHttpRequest({ req: req({ method: 'GET', url: '/webhook' }), res: response, config: {}, verifySignatures: false })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, endpoint: '/webhook' })
})

test('/webhook handles Slack url_verification with HTTP 200 and plain challenge', async () => {
  const response = res()
  await handleHttpRequest({
    req: req({ method: 'POST', url: '/webhook', body: JSON.stringify({ type: 'url_verification', challenge: 'challenge-value' }) }),
    res: response,
    config: {},
    verifySignatures: false,
  })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['Content-Type'], 'text/plain')
  assert.equal(response.body, 'challenge-value')
})

test('/mcp is disabled unless slackbotMcp.enabled is true', async () => {
  const response = res()
  await handleHttpRequest({
    req: req({ method: 'POST', url: '/mcp', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }),
    res: response,
    config: { slackbotMcp: { enabled: false } },
    verifySignatures: false,
  })
  assert.equal(response.statusCode, 404)
  assert.deepEqual(JSON.parse(response.body), { ok: false, error: 'slackbot-mcp-disabled' })
})

test('/mcp exposes only the remote-safe default tool when enabled without allowedTools', async () => {
  const response = res()
  await handleHttpRequest({
    req: signedMcpReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    res: response,
    signingSecret,
    env: {},
    config: { slackbotMcp: { enabled: true, allowedTools: [], exposeWriteTools: false }, remote: { postableChannels: [], readableChannels: [] } },
    verifySignatures: true,
  })
  assert.equal(response.statusCode, 200)
  const body = JSON.parse(response.body)
  assert.deepEqual(body.result.tools.map(tool => tool.name), ['slack_doctor'])
})

test('/mcp keeps write tools hidden unless exposeWriteTools is true', async () => {
  const response = res()
  await handleHttpRequest({
    req: signedMcpReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    res: response,
    signingSecret,
    env: {},
    config: {
      slackbotMcp: { enabled: true, allowedTools: ['slack_post', 'slack_resolve_user'], exposeWriteTools: false },
      remote: { postableChannels: [], readableChannels: [] },
    },
    verifySignatures: true,
  })
  assert.equal(response.statusCode, 200)
  const body = JSON.parse(response.body)
  assert.deepEqual(body.result.tools.map(tool => tool.name), ['slack_resolve_user'])
})

test('/mcp requires a valid Slack signature even if general HTTP signature verification is disabled', async () => {
  const response = res()
  await handleHttpRequest({
    req: req({ method: 'POST', url: '/mcp', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }),
    res: response,
    signingSecret,
    env: {},
    config: { slackbotMcp: { enabled: true }, remote: { postableChannels: [], readableChannels: [] } },
    verifySignatures: false,
  })
  assert.equal(response.statusCode, 401)
  assert.equal(JSON.parse(response.body).error, 'slack-signature-headers-required')
})

test('Slackbot MCP no_auth cannot expose actionable bridge tools', () => {
  const config = {
    slackbotMcp: {
      enabled: true,
      authType: 'no_auth',
      allowedTools: remoteToolNames,
      exposeWriteTools: true,
    },
  }
  assert.deepEqual(Object.keys(getSlackbotMcpTools(config)).sort(), ['slack_doctor'])
})

test('Slackbot MCP remote registry is exact and cannot be widened to risky local tools by config', () => {
  const config = {
    slackbotMcp: {
      enabled: true,
      allowedTools: [...remoteToolNames, ...forbiddenRemoteToolNames],
      exposeWriteTools: true,
    },
  }
  assert.deepEqual(Object.keys(getSlackbotMcpTools(config)).sort(), remoteToolNames)
})

test('Slackbot MCP import path does not load the local registry or risky remote-absent modules', () => {
  const httpSource = readFileSync(join(repoRoot, 'mcp/http.js'), 'utf8')
  const remoteSource = readFileSync(join(repoRoot, 'mcp/tools.remote.js'), 'utf8')
  const combined = `${httpSource}\n${remoteSource}`

  assert.ok(!combined.includes('./tools.local.js'))
  assert.ok(!combined.includes('../core/dm.js'))
  assert.ok(!combined.includes('../core/ask.js'))
  assert.ok(!combined.includes('../core/search.js'))
  assert.ok(!combined.includes('slack_post_as_user'))
  assert.ok(!combined.includes('slack_search'))
})

test('/mcp validates tool arguments before invoking remote-safe tools', async () => {
  const response = res()
  await handleHttpRequest({
    req: signedMcpReq({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'slack_doctor', arguments: { username: 'bad' } },
    }),
    res: response,
    signingSecret,
    env: {},
    config: { slackbotMcp: { enabled: true }, remote: { postableChannels: [], readableChannels: [] } },
    verifySignatures: true,
  })
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).error.message, 'unknown argument: username')
})

test('/mcp remote doctor handles partial config objects without leaking local token presence', async () => {
  const response = res()
  await handleHttpRequest({
    req: signedMcpReq({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'slack_doctor', arguments: {} },
    }),
    res: response,
    signingSecret,
    env: {},
    config: { slackbotMcp: { enabled: true } },
    verifySignatures: true,
  })
  assert.equal(response.statusCode, 200)
  const result = JSON.parse(JSON.parse(response.body).result.content[0].text)
  assert.deepEqual(result, { profile: 'remote', connected: false, postableChannels: [], readableChannels: [] })
})

test('/mcp requires Slack identity metadata for actionable remote calls', async () => {
  const response = res()
  await handleHttpRequest({
    req: signedMcpReq({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'slack_post', arguments: { channel: 'C1', text: 'hi', idempotencyKey: 'remote-key-identity', dryRun: true } },
    }),
    res: response,
    signingSecret,
    env: {},
    config: {
      slackbotMcp: { enabled: true, allowedTools: ['slack_post'], exposeWriteTools: true },
      remote: { postableChannels: ['C1'], readableChannels: [] },
    },
    verifySignatures: true,
  })
  assert.equal(response.statusCode, 200)
  const result = JSON.parse(JSON.parse(response.body).result.content[0].text)
  assert.equal(result.error, 'remote-mcp-slack-identity-required')
})

test('/mcp requires idempotency keys for remote post and reply ownership', async () => {
  const response = res()
  const dbPath = tempDbPath()
  await handleHttpRequest({
    req: signedMcpReq({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'slack_post',
        arguments: { channel: 'C1', text: 'hi', dryRun: true },
        _meta: { slack: { user_id: 'U1', team_id: 'T1', enterprise_id: null } },
      },
    }),
    res: response,
    signingSecret,
    env: {},
    config: {
      slackbotMcp: { enabled: true, allowedTools: ['slack_post'], exposeWriteTools: true },
      remote: { postableChannels: ['C1'], readableChannels: [] },
    },
    dbPath,
    verifySignatures: true,
  })
  assert.equal(response.statusCode, 200)
  const result = JSON.parse(JSON.parse(response.body).result.content[0].text)
  assert.equal(result.error, 'remote-mcp-idempotency-key-required')
})

test('/mcp applies remote channel allowlists before invoking channel tools', async () => {
  const response = res()
  const dbPath = tempDbPath()
  await handleHttpRequest({
    req: signedMcpReq({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'slack_post',
          arguments: { channel: 'C2', text: 'hi', idempotencyKey: 'remote-key-1', dryRun: true },
          _meta: { slack: { user_id: 'U1', team_id: 'T1', enterprise_id: null } },
        },
    }),
    res: response,
    signingSecret,
    env: {},
    config: {
      slackbotMcp: { enabled: true, allowedTools: ['slack_post'], exposeWriteTools: true },
      remote: { postableChannels: ['C1'], readableChannels: [] },
    },
    dbPath,
    verifySignatures: true,
  })
  assert.equal(response.statusCode, 200)
  const result = JSON.parse(JSON.parse(response.body).result.content[0].text)
  assert.deepEqual(result, { ok: false, error: 'channel-not-remote-postable', retryable: false })
})

test('/mcp allows configured remote channel tools after allowlist check', async () => {
  const response = res()
  const dbPath = tempDbPath()
  await handleHttpRequest({
    req: signedMcpReq({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'slack_post',
          arguments: { channel: 'C1', text: 'hi', idempotencyKey: 'remote-key-2', dryRun: true },
          _meta: { slack: { user_id: 'U1', team_id: 'T1', enterprise_id: null } },
        },
    }),
    res: response,
    signingSecret,
    env: {},
    config: {
      slackbotMcp: { enabled: true, allowedTools: ['slack_post'], exposeWriteTools: true },
      remote: { postableChannels: ['C1'], readableChannels: [] },
    },
    dbPath,
    verifySignatures: true,
  })
  assert.equal(response.statusCode, 200)
  const result = JSON.parse(JSON.parse(response.body).result.content[0].text)
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.match(result.request.body.text, /via Slackbot MCP by <@U1>/)
})

test('/mcp enforces per-principal remote quota from the audit table', async () => {
  const dbPath = tempDbPath()
  const config = {
    slackbotMcp: { enabled: true, allowedTools: ['slack_post'], exposeWriteTools: true, rateLimitPerMinute: 1 },
    remote: { postableChannels: ['C1'], readableChannels: [] },
  }
  for (const [id, expectedError] of [[1, undefined], [2, 'remote-mcp-rate-limit-exceeded']]) {
    const response = res()
    await handleHttpRequest({
      req: signedMcpReq({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: {
          name: 'slack_post',
          arguments: { channel: 'C1', text: 'hi', idempotencyKey: `quota-key-${id}`, dryRun: true },
          _meta: { slack: { user_id: 'U1', team_id: 'T1', enterprise_id: null } },
        },
      }),
      res: response,
      signingSecret,
      env: {},
      config,
      dbPath,
      verifySignatures: true,
    })
    const result = JSON.parse(JSON.parse(response.body).result.content[0].text)
    if (expectedError) assert.equal(result.error, expectedError)
    else assert.equal(result.ok, true)
  }
})

test('/mcp update/delete only touch messages owned by the same remote principal', async () => {
  const dbPath = tempDbPath()
  complete(dbPath, 'local-message', { channel: 'C1', ts: '111.1' })
  complete(dbPath, 'other-remote-message', { channel: 'C1', ts: '222.2', remote: true, principal: 'U2' })
  complete(dbPath, 'same-remote-message', { channel: 'C1', ts: '333.3', remote: true, principal: 'U1' })

  const config = {
    slackbotMcp: { enabled: true, allowedTools: ['slack_update_message'], exposeWriteTools: true },
    remote: { postableChannels: ['C1'], readableChannels: [] },
  }

  for (const ts of ['111.1', '222.2']) {
    const response = res()
    await handleHttpRequest({
      req: signedMcpReq({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'slack_update_message',
          arguments: { channel: 'C1', ts, text: 'updated', dryRun: true },
          _meta: { slack: { user_id: 'U1', team_id: 'T1', enterprise_id: null } },
        },
      }),
      res: response,
      signingSecret,
      env: {},
      config,
      dbPath,
      verifySignatures: true,
    })
    const result = JSON.parse(JSON.parse(response.body).result.content[0].text)
    assert.equal(result.error, 'remote-mcp-not-own-message')
  }

  const response = res()
  await handleHttpRequest({
    req: signedMcpReq({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'slack_update_message',
        arguments: { channel: 'C1', ts: '333.3', text: 'updated', dryRun: true },
        _meta: { slack: { user_id: 'U1', team_id: 'T1', enterprise_id: null } },
      },
    }),
    res: response,
    signingSecret,
    env: {},
    config,
    dbPath,
    verifySignatures: true,
  })
  const result = JSON.parse(JSON.parse(response.body).result.content[0].text)
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
})

test('/mcp cannot transfer remote ownership by replaying another principal idempotency key', async () => {
  const dbPath = tempDbPath()
  complete(dbPath, 'remote-key-owned', { channel: 'C1', ts: '444.4', remote: true, principal: 'U1' })

  const response = res()
  await handleHttpRequest({
    req: signedMcpReq({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'slack_post',
        arguments: { channel: 'C1', text: 'take over', idempotencyKey: 'remote-key-owned', dryRun: true },
        _meta: { slack: { user_id: 'U2', team_id: 'T1', enterprise_id: null } },
      },
    }),
    res: response,
    signingSecret,
    env: {},
    config: {
      slackbotMcp: { enabled: true, allowedTools: ['slack_post'], exposeWriteTools: true },
      remote: { postableChannels: ['C1'], readableChannels: [] },
    },
    dbPath,
    verifySignatures: true,
  })
  const result = JSON.parse(JSON.parse(response.body).result.content[0].text)
  assert.equal(result.error, 'remote-mcp-idempotency-key-owned-by-different-principal')
})
