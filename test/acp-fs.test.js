import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
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

// A textually-inside-the-repo path can still escape via a symlink that
// resolve() (string normalization only, never touches the filesystem)
// cannot see. Found in review before publishing — resolve()-only checks
// pass this even though the real target is outside the repo entirely.
test('assertInsideRepo rejects a path that is textually inside the repo but escapes via a symlink', () => {
  withTempRepo(outsideRepoRoot => {
    withTempRepo(repoRoot => {
      const outsideTarget = join(outsideRepoRoot, 'secret.txt')
      writeFileSync(outsideTarget, 'not meant to be reachable')
      const symlinkPath = join(repoRoot, 'escape-link')
      symlinkSync(outsideRepoRoot, symlinkPath)
      assert.throws(() => assertInsideRepo(repoRoot, join(symlinkPath, 'secret.txt')))
    })
  })
})

test('readTextFile rejects reading through a symlink that escapes the repo', async () => {
  await withTempRepo(async outsideRepoRoot => {
    await withTempRepo(async repoRoot => {
      writeFileSync(join(outsideRepoRoot, 'secret.txt'), 'not meant to be reachable')
      symlinkSync(outsideRepoRoot, join(repoRoot, 'escape-link'))
      const handlers = createFsHandlers(repoRoot)
      await assert.rejects(() => handlers.readTextFile({ path: join(repoRoot, 'escape-link', 'secret.txt') }))
    })
  })
})

test('writeTextFile rejects writing through a symlink that escapes the repo', async () => {
  await withTempRepo(async outsideRepoRoot => {
    await withTempRepo(async repoRoot => {
      symlinkSync(outsideRepoRoot, join(repoRoot, 'escape-link'))
      const handlers = createFsHandlers(repoRoot)
      await assert.rejects(() => handlers.writeTextFile({ path: join(repoRoot, 'escape-link', 'pwned.txt'), content: 'nope' }))
    })
  })
})
