import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isAway, setAway, getAwayFlagPath, getAwayConfig } from '../core/away.js'

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'away-test-'))
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

test('isAway returns false when no flag file exists', () => {
  withTempHome(() => {
    assert.equal(isAway(), false)
  })
})

test('setAway(true) creates a flag file and isAway returns true', () => {
  withTempHome(() => {
    const result = setAway(true)
    assert.equal(result.ok, true)
    assert.equal(result.away, true)
    assert.equal(isAway(), true)
    assert.ok(existsSync(getAwayFlagPath()))
  })
})

test('setAway(false) removes the flag file', () => {
  withTempHome(() => {
    setAway(true)
    assert.equal(isAway(), true)
    setAway(false)
    assert.equal(isAway(), false)
    assert.ok(!existsSync(getAwayFlagPath()))
  })
})

test('getAwayConfig returns the stored config when away', () => {
  withTempHome(() => {
    setAway(true, { timeoutSeconds: 3600, maxContinuations: 5 })
    const config = getAwayConfig()
    assert.equal(config.timeoutSeconds, 3600)
    assert.equal(config.maxContinuations, 5)
    assert.ok(config.since)
  })
})

test('away mode auto-expires after timeoutSeconds', () => {
  withTempHome(() => {
    setAway(true, { timeoutSeconds: 1 })
    // Patch the since timestamp to be in the past
    const path = getAwayFlagPath()
    const data = JSON.parse(readFileSync(path, 'utf8'))
    data.since = new Date(Date.now() - 5000).toISOString()
    writeFileSync(path, JSON.stringify(data))
    assert.equal(isAway(), false)
  })
})

test('getAwayConfig returns null when not away', () => {
  withTempHome(() => {
    assert.equal(getAwayConfig(), null)
  })
})
