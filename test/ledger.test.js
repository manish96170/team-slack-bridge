import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claim, complete, findByTs } from '../core/ledger.js'

function tempLedgerPath() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-test-'))
  return join(dir, 'ledger.json')
}

test('claiming a new key returns null (proceed); completing then re-claiming returns the previous result', () => {
  const path = tempLedgerPath()
  assert.equal(claim(path, 'key-1'), null)
  complete(path, 'key-1', { channel: 'C1', ts: '111.1' })

  const second = claim(path, 'key-1')
  assert.equal(second.status, 'done')
  assert.deepEqual(second.result, { channel: 'C1', ts: '111.1' })
})

test('a pending (not-yet-completed) claim refuses a second concurrent claim rather than proceeding', () => {
  const path = tempLedgerPath()
  assert.equal(claim(path, 'key-2'), null)
  const second = claim(path, 'key-2')
  assert.equal(second.status, 'pending')
})

test('findByTs locates the ledger entry that recorded a given channel+ts, and only a completed one', () => {
  const path = tempLedgerPath()
  complete(path, 'key-3', { channel: 'C1', ts: '222.2' })
  assert.ok(findByTs(path, 'C1', '222.2'))
  assert.equal(findByTs(path, 'C1', '999.9'), null)
  assert.equal(findByTs(path, 'C_OTHER', '222.2'), null)
})

test('a claim with no key is a no-op, never throws', () => {
  const path = tempLedgerPath()
  assert.equal(claim(path, undefined), null)
  complete(path, undefined, { channel: 'C1', ts: '1.1' })
})
