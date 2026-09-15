import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFsHandlers, assertInsideRepo } from '../core/acp-fs.js'

async function withTempRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-acp-fs-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('assertInsideRepo accepts a path inside the repo root', () => {
  withTempRepo(repoRoot => {
    assert.equal(assertInsideRepo(repoRoot, join(repoRoot, 'sub', 'file.txt')), join(repoRoot, 'sub', 'file.txt'))
  })
})

test('assertInsideRepo rejects a path that escapes the repo root via ../ (PLAN D23)', () => {
  withTempRepo(repoRoot => {
    assert.throws(() => assertInsideRepo(repoRoot, join(repoRoot, '..', 'outside.txt')))
  })
})

test('assertInsideRepo rejects an absolute path entirely outside the repo root', () => {
  withTempRepo(repoRoot => {
    assert.throws(() => assertInsideRepo(repoRoot, '/etc/passwd'))
  })
})

test('writeTextFile inside the repo creates parent directories and writes real content', async () => {
  await withTempRepo(async repoRoot => {
    const handlers = createFsHandlers(repoRoot)
    const target = join(repoRoot, 'nested', 'new-file.txt')
    await handlers.writeTextFile({ path: target, content: 'hello from an ACP agent' })
    assert.equal(readFileSync(target, 'utf8'), 'hello from an ACP agent')
  })
})

test('writeTextFile outside the repo is rejected before touching the filesystem', async () => {
  await withTempRepo(async repoRoot => {
    const handlers = createFsHandlers(repoRoot)
    await assert.rejects(() => handlers.writeTextFile({ path: '/tmp/tsb-should-never-exist.txt', content: 'nope' }))
  })
})

test('readTextFile round-trips a written file, and respects line/limit', async () => {
  await withTempRepo(async repoRoot => {
    const handlers = createFsHandlers(repoRoot)
    const target = join(repoRoot, 'lines.txt')
    await handlers.writeTextFile({ path: target, content: 'one\ntwo\nthree\nfour' })
    const full = await handlers.readTextFile({ path: target })
    assert.equal(full.content, 'one\ntwo\nthree\nfour')
    const partial = await handlers.readTextFile({ path: target, line: 2, limit: 2 })
    assert.equal(partial.content, 'two\nthree')
  })
})

test('readTextFile outside the repo is rejected', async () => {
  await withTempRepo(async repoRoot => {
    const handlers = createFsHandlers(repoRoot)
    await assert.rejects(() => handlers.readTextFile({ path: '/etc/hosts' }))
  })
})
