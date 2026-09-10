// The one Slack Web API helper every core function goes through. Structured
// results only — { ok:false, error, retryable }, never a thrown string — so
// a caller (the dashboard's outbox, a CLI, an MCP tool) can always tell
// "retry me" from "this will never work" (PLAN §7).
//
// Takes no ambient state: token and body are parameters, not process.env
// reads (PLAN §0/D2). No console.log — stdout is the MCP protocol (§6.3).

import { ErrorCode, LogLevel, WebClient } from '@slack/web-api'

const RETRYABLE_SLACK_ERRORS = new Set(['ratelimited', 'internal_error', 'fatal_error', 'request_timeout'])
const clients = new Map()

export function getSlackClient(token) {
  if (!token) return null
  let client = clients.get(token)
  if (client) return client
  client = new WebClient(token, {
    retryConfig: { retries: 2, factor: 2, minTimeout: 500, maxTimeout: 2000, randomize: true },
    rejectRateLimitedCalls: false,
    timeout: 10000,
    logLevel: LogLevel.ERROR,
  })
  clients.set(token, client)
  return client
}

export async function callSlack(method, token, body = {}) {
  if (!token) return { ok: false, error: 'no-token', retryable: false }

  try {
    const data = await getSlackClient(token).apiCall(method, body)
    return { ok: true, ...data }
  } catch (err) {
    if (err.code === ErrorCode.PlatformError) {
      const error = err.data?.error || 'unknown-slack-error'
      return { ok: false, error, retryable: RETRYABLE_SLACK_ERRORS.has(error) }
    }
    if (err.code === ErrorCode.RateLimitedError) {
      return { ok: false, error: 'rate-limited', retryable: true, retryAfter: err.retryAfter }
    }
    if (err.code === ErrorCode.RequestError || err.code === ErrorCode.HTTPError) {
      return { ok: false, error: `network-error: ${err.message}`, retryable: true }
    }
    return { ok: false, error: err.message || 'unknown-slack-error', retryable: false }
  }
}
