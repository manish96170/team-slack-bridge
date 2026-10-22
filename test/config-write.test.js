import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setOutputModeInConfig } from '../core/config-write.js'

function mode(path) {
  return statSync(path).mode & 0o777
}

// Local state files hold real people's names/handles/Slack IDs
// (slack-config.json's `users` list) — not credentials, but still PII that
// shouldn't be world-readable on a shared machine. `writeFileSync`'s
// `{ mode }` option only applies when the file is newly CREATED, so an
// explicit chmod on every write is what actually enforces this on a file
// that already existed with looser permissions (the exact gap found during
// a security audit of this MCP server, 2026-10-22).
test('setOutputModeInConfig writes slack-config.json as 0600 on first creation', () => {
  if (process.platform === 'win32') return
  const path = join(mkdtempSync(join(tmpdir(), 'config-write-test-')), 'slack-config.json')
  const result = setOutputModeInConfig({ config: {}, configPath: path, outputMode: 'high' })
  assert.equal(result.ok, true)
  assert.equal(mode(path), 0o600)
})

test('setOutputModeInConfig self-heals an existing 0644 file back to 0600 on write', () => {
  if (process.platform === 'win32') return
  const path = join(mkdtempSync(join(tmpdir(), 'config-write-test-')), 'slack-config.json')
  writeFileSync(path, '{}')
  chmodSync(path, 0o644)
  assert.equal(mode(path), 0o644, 'precondition: file starts world-readable')

  setOutputModeInConfig({ config: {}, configPath: path, outputMode: 'low' })

  assert.equal(mode(path), 0o600, 'write must chmod explicitly, not rely on the create-only {mode} option')
})
