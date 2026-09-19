import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldGate, failMode, normalizeToolName } from '../core/away-policy.js'

test('shouldGate: default gated tools include Bash, Edit, Write, NotebookEdit', () => {
  assert.equal(shouldGate('Bash'), true)
  assert.equal(shouldGate('Edit'), true)
  assert.equal(shouldGate('Write'), true)
  assert.equal(shouldGate('NotebookEdit'), true)
})

test('shouldGate: Read is not gated by default', () => {
  assert.equal(shouldGate('Read'), false)
})

test('shouldGate: respects custom gatedTools from config', () => {
  const config = { awayMode: { gatedTools: ['Read', 'Bash'] } }
  assert.equal(shouldGate('Read', { config }), true)
  assert.equal(shouldGate('Bash', { config }), true)
  assert.equal(shouldGate('Edit', { config }), false)
})

test('normalizeToolName: maps OpenCode lowercase to Claude-style names', () => {
  assert.equal(normalizeToolName('bash'), 'Bash')
  assert.equal(normalizeToolName('edit'), 'Edit')
  assert.equal(normalizeToolName('write'), 'Write')
  assert.equal(normalizeToolName('read'), 'Read')
})

test('normalizeToolName: passes through already-normalized names unchanged', () => {
  assert.equal(normalizeToolName('Bash'), 'Bash')
  assert.equal(normalizeToolName('SomeCustomTool'), 'SomeCustomTool')
})

test('shouldGate: alias map makes gating case-insensitive across harnesses', () => {
  assert.equal(shouldGate('bash'), true)
  assert.equal(shouldGate('BASH'), true)
  assert.equal(shouldGate('edit'), true)
})

// D39 — the single most important assertion in this change
test('failMode: Claude can defer, OpenCode cannot', () => {
  assert.equal(failMode('claude'), 'defer')
  assert.equal(failMode('opencode'), 'deny')
})

test('failMode: unknown harnesses default to deny (safe default)', () => {
  assert.equal(failMode('unknown'), 'deny')
  assert.equal(failMode(undefined), 'deny')
})
