import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-install-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('Claude installer merges into existing settings.json without clobbering unrelated hooks', () => {
  withTempDir(dir => {
    const claudeDir = join(dir, '.claude')
    const settingsPath = join(claudeDir, 'settings.json')
    // Pre-existing settings with a gitnexus hook — must survive
    const existing = {
      hooks: {
        PreToolUse: [
          { matcher: 'Grep|Glob|Bash', hooks: [{ type: 'command', command: 'gitnexus-hook preToolUse' }] },
        ],
      },
      someOtherKey: true,
    }
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2))

    execFileSync(process.execPath, ['cli/hooks-install.js', 'claude', '--project', dir, '--json'])

    const after = JSON.parse(readFileSync(settingsPath, 'utf8'))
    // gitnexus hook must still be there
    assert.ok(after.hooks.PreToolUse.some(e => e.hooks?.some(h => h.command?.includes('gitnexus'))), 'gitnexus hook was clobbered')
    // our hook must be there too
    assert.ok(after.hooks.PreToolUse.some(e => e.hooks?.some(h => h.command?.includes('tsb-hook'))), 'tsb-hook was not added')
    // other events must be present
    assert.ok(after.hooks.Stop?.length > 0)
    assert.ok(after.hooks.Notification?.length > 0)
    // unrelated keys preserved
    assert.equal(after.someOtherKey, true)
  })
})

test('Claude installer is idempotent — running twice does not duplicate entries', () => {
  withTempDir(dir => {
    const claudeDir = join(dir, '.claude')
    mkdirSync(claudeDir, { recursive: true })
    writeFileSync(join(claudeDir, 'settings.json'), '{}')

    execFileSync(process.execPath, ['cli/hooks-install.js', 'claude', '--project', dir, '--json'])
    execFileSync(process.execPath, ['cli/hooks-install.js', 'claude', '--project', dir, '--json'])

    const after = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'))
    const tsbPreToolUse = after.hooks.PreToolUse.filter(e => e.hooks?.some(h => h.command?.includes('tsb-hook')))
    assert.equal(tsbPreToolUse.length, 1, 'should have exactly 1 tsb-hook PreToolUse entry, not duplicates')
  })
})
