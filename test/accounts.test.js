import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listAccounts, resolveAccountHome, loadAccountContext, addAccount, removeAccount, setDefaultAccount } from '../core/accounts.js'

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-accounts-'))
  const original = process.env.TSB_HOME
  process.env.TSB_HOME = dir
  try {
    return fn(dir)
  } finally {
    if (original === undefined) delete process.env.TSB_HOME
    else process.env.TSB_HOME = original
    rmSync(dir, { recursive: true, force: true })
  }
}

test('listAccounts synthesizes a single "default" account when accounts.json is absent', () => {
  withTempHome(dir => {
    assert.deepEqual(listAccounts(), { default: 'default', accounts: { default: dir } })
  })
})

test('addAccount preserves the pre-existing home as "default" and adds the new one', () => {
  withTempHome(dir => {
    const workHome = join(dir, 'work')
    assert.deepEqual(addAccount('work', workHome), { ok: true, name: 'work', home: workHome })
    const accounts = listAccounts()
    assert.equal(accounts.default, 'default')
    assert.deepEqual(accounts.accounts, { default: dir, work: workHome })
  })
})

test('resolveAccountHome errors clearly on an unknown account name', () => {
  withTempHome(() => {
    assert.deepEqual(resolveAccountHome('nonexistent'), { ok: false, error: 'account-not-found', name: 'nonexistent', retryable: false })
  })
})

test('setDefaultAccount switches which account resolveAccountHome() returns with no name given', () => {
  withTempHome(dir => {
    addAccount('work', join(dir, 'work'))
    setDefaultAccount('work')
    assert.equal(resolveAccountHome().name, 'work')
  })
})

test('removeAccount falls back the default to another account when the current default is removed', () => {
  withTempHome(dir => {
    addAccount('work', join(dir, 'work'))
    removeAccount('default')
    assert.equal(listAccounts().default, 'work')
  })
})

test('loadAccountContext reads env/config from the resolved account home, not the process TSB_HOME', () => {
  withTempHome(dir => {
    const workHome = join(dir, 'work')
    addAccount('work', workHome)
    mkdirSync(workHome, { recursive: true })
    writeFileSync(join(workHome, '.env'), 'SLACK_BOT_TOKEN=xoxb-work-token\n')
    const context = loadAccountContext('work')
    assert.equal(context.ok, true)
    assert.equal(context.accountName, 'work')
    assert.equal(context.env.SLACK_BOT_TOKEN, 'xoxb-work-token')
    assert.equal(context.dbPath, join(workHome, '.ledger.sqlite'))
  })
})
