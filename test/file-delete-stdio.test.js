import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('stdio MCP exposes file deletion, previews it and rejects unconfirmed deletion', () => {
  const home = mkdtempSync(join(tmpdir(), 'tsb-stdio-file-'))
  const server = fileURLToPath(new URL('../mcp/server.js', import.meta.url))
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'slack_delete_file', arguments: { fileId: 'F123', dryRun: true } } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slack_delete_file', arguments: { fileId: 'F123' } } },
  ]
  const processResult = spawnSync(process.execPath, [server], { input: requests.map(JSON.stringify).join('\n') + '\n', encoding: 'utf8', env: { ...process.env, TSB_HOME: home } })
  assert.equal(processResult.status, 0, processResult.stderr)
  const responses = processResult.stdout.trim().split('\n').map(JSON.parse)
  const byId = Object.fromEntries(responses.map(response => [response.id, response]))
  assert.ok(byId[1].result.tools.some(tool => tool.name === 'slack_delete_file'))
  assert.equal(JSON.parse(byId[2].result.content[0].text).request.body.file, 'F123')
  assert.equal(JSON.parse(byId[3].result.content[0].text).error, 'file-deletion-confirmation-required')
})
