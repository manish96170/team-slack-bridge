import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../cli/delete-file.js', import.meta.url))

test('delete-file CLI supports explicit accounts, dry runs, confirmation and refuses unknown accounts', () => {
  const home = mkdtempSync(join(tmpdir(), 'tsb-delete-file-cli-'))
  const work = join(home, 'work')
  mkdirSync(work)
  writeFileSync(join(home, 'accounts.json'), JSON.stringify({ default: 'default', accounts: { default: { home }, work: { home: work } } }))
  const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args, '--json'], { encoding: 'utf8', env: { ...process.env, TSB_HOME: home } })
    return { status: result.status, body: JSON.parse(result.stdout) }
  }
  const preview = run('--file-id', 'F123', '--account', 'work', '--dry-run')
  assert.equal(preview.status, 0)
  assert.equal(preview.body.account, 'work')
  assert.equal(preview.body.tokenSource, 'user')
  assert.deepEqual(preview.body.request.body, { file: 'F123' })
  const missing = run('--file-id', 'F123', '--account', 'missing', '--dry-run')
  assert.equal(missing.status, 1)
  assert.equal(missing.body.error, 'account-not-found')
  const emptyAccount = run('--file-id', 'F123', '--account')
  assert.equal(emptyAccount.status, 1)
  assert.equal(emptyAccount.body.error, 'account-required')
  const unconfirmed = run('--file-id', 'F123', '--account', 'work')
  assert.equal(unconfirmed.status, 1)
  assert.equal(unconfirmed.body.error, 'file-deletion-confirmation-required')
  const botPreview = run('--file-id', 'F123', '--account', 'work', '--via-bot', '--dry-run')
  assert.equal(botPreview.body.tokenSource, 'bot')
  const swallowed = run('--file-id', '--dry-run', '--confirm')
  assert.equal(swallowed.body.error, 'fileId-required')
  writeFileSync(join(home, 'accounts.json'), JSON.stringify({ default: 'ghost', accounts: { work: { home: work } } }))
  const invalidDefault = run('--file-id', 'F123', '--dry-run')
  assert.equal(invalidDefault.body.error, 'account-not-found')
  assert.equal(invalidDefault.body.name, 'ghost')
})
