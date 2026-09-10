import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startProgress, updateProgress, finishProgress, renderProgress } from '../core/progress.js'

test('startProgress posts a reusable status message', async () => {
  const result = await startProgress({ channel: '#ops', label: 'Deploy', detail: 'building', dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.request.method, 'chat.postMessage')
  assert.equal(result.request.body.text, '*Deploy* — started\nbuilding')
})

test('updateProgress edits the existing status message', async () => {
  const result = await updateProgress({ channel: '#ops', ts: '1.1', label: 'Deploy', status: 'running', dryRun: true })
  assert.equal(result.ok, true)
  assert.equal(result.request.method, 'chat.update')
  assert.equal(result.request.body.text, '*Deploy* — running')
})

test('finishProgress marks success or failure', async () => {
  const result = await finishProgress({ channel: '#ops', ts: '1.1', label: 'Deploy', ok: false, detail: 'tests failed', dryRun: true })
  assert.equal(result.request.body.text, '*Deploy* — failed\ntests failed')
})

test('renderProgress respects outputMode', () => {
  assert.equal(renderProgress({ label: 'Deploy', status: 'running', detail: 'tests', outputMode: 'low' }), '*Deploy* — running')
  assert.equal(renderProgress({ label: 'Deploy', status: 'running', detail: 'tests', outputMode: 'high' }), '*Deploy* — running\ntests\n_mode: high_')
})
