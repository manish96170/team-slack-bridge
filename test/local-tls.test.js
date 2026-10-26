import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureLocalTlsCert, loadLocalTlsCert, localTlsPaths } from '../core/local-tls.js'

function mode(path) {
  return statSync(path).mode & 0o777
}

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-tls-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('ensureLocalTlsCert generates a cert/key for localhost on first call', () => {
  withTempHome(home => {
    const result = ensureLocalTlsCert(home)
    assert.equal(result.ok, true)
    assert.equal(result.generated, true)
    const { keyPath, certPath } = localTlsPaths(home)
    assert.deepEqual(result, { ok: true, generated: true, keyPath, certPath })
  })
})

test('ensureLocalTlsCert is idempotent -- a second call reuses the existing cert, does not regenerate', () => {
  withTempHome(home => {
    const first = ensureLocalTlsCert(home)
    const firstCertBytes = readFileSync(first.certPath)
    const second = ensureLocalTlsCert(home)
    assert.equal(second.ok, true)
    assert.equal(second.generated, false)
    assert.deepEqual(readFileSync(second.certPath), firstCertBytes)
  })
})

test('the generated private key is written 0600, same posture as every other local secret (D44)', () => {
  if (process.platform === 'win32') return
  withTempHome(home => {
    const result = ensureLocalTlsCert(home)
    assert.equal(mode(result.keyPath), 0o600)
  })
})

test('the generated cert actually covers localhost and 127.0.0.1 (not just a generic CN)', () => {
  withTempHome(home => {
    const result = ensureLocalTlsCert(home)
    const text = execFileSync('openssl', ['x509', '-in', result.certPath, '-noout', '-ext', 'subjectAltName']).toString()
    assert.match(text, /DNS:localhost/)
    assert.match(text, /IP Address:127\.0\.0\.1/)
  })
})

test('loadLocalTlsCert returns usable key/cert buffers that a real https.createServer accepts', async () => {
  await withTempHome(async home => {
    const { createServer } = await import('node:https')
    const loaded = loadLocalTlsCert(home)
    assert.equal(loaded.ok, true)
    const server = createServer({ cert: loaded.cert, key: loaded.key }, (req, res) => res.end('ok'))
    await new Promise(resolve => server.listen(0, resolve))
    const port = server.address().port
    try {
      const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' // self-signed, same as a real browser's one-time warning
      const res = await fetch(`https://localhost:${port}/`)
      assert.equal(res.status, 200)
      assert.equal(await res.text(), 'ok')
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous
    } finally {
      await new Promise(resolve => server.close(resolve))
    }
  })
})

test('ensureLocalTlsCert reports a clear error, not a crash, when openssl is missing from PATH', () => {
  withTempHome(home => {
    const previousPath = process.env.PATH
    process.env.PATH = ''
    try {
      const result = ensureLocalTlsCert(home)
      assert.equal(result.ok, false)
      assert.equal(result.error, 'openssl-not-found')
      assert.equal(result.retryable, false)
    } finally {
      process.env.PATH = previousPath
    }
  })
})
