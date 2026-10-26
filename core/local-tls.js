// Local-only HTTPS support for the OAuth redirect callback (PLAN D55).
// Slack's "Use HTTPS For Your Features" public-distribution check does not
// exempt localhost redirect URLs the way Socket Mode exempts Slash Commands/
// Interactivity/Event Subscriptions request URLs -- so a registered
// http://localhost:PORT/callback blocks Public Distribution outright.
//
// This generates a self-signed cert for localhost/127.0.0.1 via the
// system's own `openssl` binary (near-universal on macOS/Linux dev
// machines; Windows needs Git Bash or WSL) -- no new npm dependency, one
// clearly-reported error if openssl isn't found rather than a silent
// fallback to plain HTTP. Let's Encrypt cannot be used here: it only
// certifies domains it can verify ownership of over the public internet,
// and localhost isn't one. For a warning-free browser experience instead
// of the one-time self-signed-cert warning, mkcert (https://mkcert.dev) is
// a reasonable free alternative -- not wired in here since it is a
// separate binary to install, not something this repo can assume.

import { existsSync, readFileSync, mkdirSync, chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export function localTlsPaths(home) {
  const dir = join(home, 'tls')
  return { dir, keyPath: join(dir, 'localhost-key.pem'), certPath: join(dir, 'localhost-cert.pem') }
}

export function ensureLocalTlsCert(home) {
  const { dir, keyPath, certPath } = localTlsPaths(home)
  if (existsSync(keyPath) && existsSync(certPath)) {
    return { ok: true, generated: false, keyPath, certPath }
  }

  mkdirSync(dir, { recursive: true })
  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '825', '-nodes',
        '-keyout', keyPath, '-out', certPath,
        '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'pipe' },
    )
  } catch (err) {
    const notFound = err.code === 'ENOENT'
    return {
      ok: false,
      error: notFound ? 'openssl-not-found' : 'openssl-failed',
      retryable: false,
      detail: notFound
        ? 'openssl was not found on PATH -- install it (macOS: already present or `brew install openssl`; Linux: your package manager; Windows: Git Bash or WSL), then retry.'
        : err.stderr?.toString() || err.message,
    }
  }

  // Private key: same posture as every other local secret in this repo
  // (D44) -- 0600, explicitly chmod'd rather than relying on the create-only
  // `{ mode }` option. The cert itself is public by definition (that's the
  // point of a certificate), so it is left at the default mode.
  chmodSync(keyPath, 0o600)
  return { ok: true, generated: true, keyPath, certPath }
}

export function loadLocalTlsCert(home) {
  const result = ensureLocalTlsCert(home)
  if (!result.ok) return result
  return { ok: true, key: readFileSync(result.keyPath), cert: readFileSync(result.certPath) }
}
