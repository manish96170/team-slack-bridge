// cli/context.js resolves REPO_ROOT/CONFIG_PATH/LEDGER_PATH/loadContext()
// through core/accounts.js's registered default (D66) — found live: setting
// a non-"default" account as the registered default had no effect on
// mcp/server.js or any other cli/*.js command, only on the already
// account-aware functions (resolveAccountHome/loadAccountContext,
// cli/accounts.js, cli/dm-by-name.js). This asserts both halves: an
// untouched install (no accounts.json) resolves exactly as before, and a
// registered default pointing somewhere else is actually honored.
//
// cli/context.js computes its exports at MODULE LOAD time, so each test
// re-imports it fresh (via a cache-busting query string) after setting up
// TSB_HOME/accounts.json, rather than importing it once at the top of this
// file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-context-'))
  const original = process.env.TSB_HOME
  process.env.TSB_HOME = dir
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (original === undefined) delete process.env.TSB_HOME
      else process.env.TSB_HOME = original
      rmSync(dir, { recursive: true, force: true })
    })
}

async function freshContext() {
  // cache-bust so each test's TSB_HOME/accounts.json is actually re-read
  return import(`../cli/context.js?t=${Date.now()}-${Math.random()}`)
}

test('loadContext resolves to raw TSB_HOME when accounts.json does not exist (untouched install, unchanged)', () =>
  withTempHome(async dir => {
    const { REPO_ROOT, LEDGER_PATH } = await freshContext()
    assert.equal(REPO_ROOT, dir)
    assert.equal(LEDGER_PATH, join(dir, '.ledger.sqlite'))
  }))

test('loadContext follows the registered default account, not just raw TSB_HOME (D66)', () =>
  withTempHome(async dir => {
    const otherHome = join(dir, 'anchor')
    mkdirSync(otherHome, { recursive: true })
    writeFileSync(join(otherHome, '.env'), 'SLACK_BOT_TOKEN=xoxb-anchor-token\n')
    writeFileSync(join(otherHome, 'slack-config.json'), JSON.stringify({ owner: { slackUserId: 'U0ANCHOR' } }))
    writeFileSync(
      join(dir, 'accounts.json'),
      JSON.stringify({ default: 'anchor', accounts: { default: { home: dir }, anchor: { home: otherHome } } })
    )

    const { REPO_ROOT, CONFIG_PATH, LEDGER_PATH, loadContext } = await freshContext()
    assert.equal(REPO_ROOT, otherHome)
    assert.equal(CONFIG_PATH, join(otherHome, 'slack-config.json'))
    assert.equal(LEDGER_PATH, join(otherHome, '.ledger.sqlite'))

    const context = loadContext()
    assert.equal(context.env.SLACK_BOT_TOKEN, 'xoxb-anchor-token')
    assert.equal(context.config.owner.slackUserId, 'U0ANCHOR')
    assert.equal(context.dbPath, join(otherHome, '.ledger.sqlite'))
  }))

test('loadContext stays on the "default" account home when accounts.json exists but never set a different default', () =>
  withTempHome(async dir => {
    writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ default: 'default', accounts: { default: { home: dir } } }))
    const { REPO_ROOT } = await freshContext()
    assert.equal(REPO_ROOT, dir)
  }))
