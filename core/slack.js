// The one HTTP call helper every core function goes through. Structured
// results only — { ok:false, error, retryable }, never a thrown string — so
// a caller (the dashboard's outbox, a CLI, an MCP tool) can always tell
// "retry me" from "this will never work" (PLAN §7).
//
// Takes no ambient state: token and body are parameters, not process.env
// reads (PLAN §0/D2). No console.log — stdout is the MCP protocol (§6.3).

const RETRYABLE_SLACK_ERRORS = new Set(['ratelimited'])

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function callSlack(method, token, body, { form = false, maxRetries = 3 } = {}) {
  if (!token) return { ok: false, error: 'no-token', retryable: false }

  let attempt = 0
  while (true) {
    let resp
    try {
      resp = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: form
          ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' }
          : { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: form ? new URLSearchParams(body) : JSON.stringify(body),
      })
    } catch (err) {
      return { ok: false, error: `network-error: ${err.message}`, retryable: true }
    }

    if (resp.status === 429) {
      attempt++
      if (attempt > maxRetries) return { ok: false, error: 'rate-limited', retryable: true }
      const retryAfterSeconds = Number(resp.headers.get('retry-after')) || 1
      await sleep(retryAfterSeconds * 1000)
      continue
    }

    const data = await resp.json()
    if (!data.ok) {
      return { ok: false, error: data.error || 'unknown-slack-error', retryable: RETRYABLE_SLACK_ERRORS.has(data.error) }
    }
    return { ok: true, ...data }
  }
}
