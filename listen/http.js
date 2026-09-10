import http from 'node:http'
import { classify } from '../core/classify.js'
import { recordAnswerByThread } from '../core/ask.js'
import { setOutputModeInConfig } from '../core/config-write.js'
import { verifySlackSignature } from '../core/signing.js'
import { handleMcpMessage } from '../mcp/http.js'

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function sendText(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain' })
  res.end(body)
}

function verifyIfRequired({ req, body, signingSecret, verifySignatures }) {
  if (!verifySignatures) return { ok: true }
  return verifySlackSignature({
    signingSecret,
    timestamp: req.headers['x-slack-request-timestamp'],
    signature: req.headers['x-slack-signature'],
    body,
  })
}

async function handleEvent({ parsed, config, dbPath, onClassified }) {
  const event = parsed.event
  if (!event) return { ok: true }

  if (dbPath && event.type === 'message' && event.thread_ts) {
    const captured = recordAnswerByThread(dbPath, event.channel, event.thread_ts, {
      kind: 'question',
      text: event.text,
      user: event.user,
    })
    if (captured) return { ok: true, captured: true }
  }

  const input =
    event.type === 'app_mention'
      ? { type: 'app_mention', channel: event.channel, user: event.user, text: event.text, ts: event.ts, thread_ts: event.thread_ts }
      : { type: event.type, channel_type: event.channel_type, channel: event.channel, user: event.user, text: event.text, ts: event.ts }
  await onClassified(classify(input, config))
  return { ok: true }
}

async function handleCommand({ body, config, configPath }) {
  const params = new URLSearchParams(body)
  const command = params.get('command')
  const text = (params.get('text') || '').trim()
  const expectedCommand = config.slashCommands?.outputModeCommand || '/outputmode'

  if (command !== expectedCommand) return { status: 200, body: { response_type: 'ephemeral', text: 'Unsupported command.' } }
  const result = setOutputModeInConfig({ config, configPath, outputMode: text })
  if (!result.ok) {
    return { status: 200, body: { response_type: 'ephemeral', text: 'Usage: /outputmode low|medium|high' } }
  }
  return { status: 200, body: { response_type: 'ephemeral', text: `Output mode set to ${result.outputMode}.` } }
}

async function handleMcp({ body, env, config, dbPath }) {
  if (!config.slackbotMcp?.enabled) {
    return { status: 404, body: { ok: false, error: 'slackbot-mcp-disabled' } }
  }
  const message = JSON.parse(body)
  if (Array.isArray(message)) {
    const responses = []
    for (const item of message) {
      const response = await handleMcpMessage({ message: item, env, config, dbPath })
      if (response) responses.push(response)
    }
    return { status: responses.length ? 200 : 202, body: responses }
  }
  const response = await handleMcpMessage({ message, env, config, dbPath })
  return response ? { status: 200, body: response } : { status: 202, body: { ok: true } }
}

export async function handleHttpRequest({ req, res, signingSecret, env = {}, config, configPath, dbPath, onClassified = async () => {}, onError, verifySignatures = true }) {
  try {
    if (req.method === 'GET' && req.url === '/webhook') {
      sendJson(res, 200, { ok: true, endpoint: '/webhook' })
      return
    }

    if (req.method !== 'POST') {
      sendJson(res, 404, { ok: false, error: 'not-found' })
      return
    }

    const body = await readBody(req)

    if (req.url === '/mcp') {
      if (!config.slackbotMcp?.enabled) {
        sendJson(res, 404, { ok: false, error: 'slackbot-mcp-disabled' })
        return
      }
      const verified = verifyIfRequired({ req, body, signingSecret, verifySignatures: true })
      if (!verified.ok) {
        sendJson(res, 401, verified)
        return
      }
      const response = await handleMcp({ body, env, config, dbPath })
      sendJson(res, response.status, response.body)
      return
    }

    const verified = verifyIfRequired({ req, body, signingSecret, verifySignatures })
    if (!verified.ok) {
      sendJson(res, 401, verified)
      return
    }

    if (req.url === '/slack/events' || req.url === '/webhook') {
      const parsed = JSON.parse(body)
      if (parsed.type === 'url_verification') {
        sendText(res, 200, parsed.challenge)
        return
      }
      await handleEvent({ parsed, config, dbPath, onClassified })
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.url === '/slack/commands') {
      if (!config.slashCommands?.enabled) {
        sendJson(res, 403, { ok: false, error: 'slash-commands-disabled' })
        return
      }
      const response = await handleCommand({ body, config, configPath })
      sendJson(res, response.status, response.body)
      return
    }

    sendJson(res, 404, { ok: false, error: 'not-found' })
  } catch (err) {
    if (onError) onError(err)
    sendJson(res, 500, { ok: false, error: err.message })
  }
}

export function createHttpServer(options) {
  return http.createServer(async (req, res) => handleHttpRequest({ req, res, ...options }))
}
