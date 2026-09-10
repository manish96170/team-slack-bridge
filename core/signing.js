import { createHmac, timingSafeEqual } from 'node:crypto'

const DEFAULT_TOLERANCE_SECONDS = 60 * 5

export function verifySlackSignature({ signingSecret, timestamp, body, signature, nowSeconds = Math.floor(Date.now() / 1000), toleranceSeconds = DEFAULT_TOLERANCE_SECONDS }) {
  if (!signingSecret) return { ok: false, error: 'signing-secret-required', retryable: false }
  if (!timestamp || !signature) return { ok: false, error: 'slack-signature-headers-required', retryable: false }

  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return { ok: false, error: 'invalid-slack-timestamp', retryable: false }
  if (Math.abs(nowSeconds - ts) > toleranceSeconds) return { ok: false, error: 'stale-slack-signature', retryable: false }

  const rawBody = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)
  const expected = `v0=${createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`
  const expectedBuffer = Buffer.from(expected)
  const actualBuffer = Buffer.from(signature)

  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    return { ok: false, error: 'invalid-slack-signature', retryable: false }
  }
  return { ok: true }
}
