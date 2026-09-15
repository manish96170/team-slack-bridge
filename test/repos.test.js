import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRepos, resolveRepoPath, addRepo, removeRepo, setDefaultRepo } from '../core/repos.js'

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'tsb-repos-'))
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

test('listRepos returns an empty registry with no default when repos.json is absent', () => {
  withTempHome(() => {
    assert.deepEqual(listRepos(), { default: null, repos: {} })
  })
})

test('addRepo rejects a path that does not exist, so a session can never be pointed at nothing', () => {
  withTempHome(dir => {
    const result = addRepo('ghost', join(dir, 'does-not-exist'))
    assert.equal(result.ok, false)
    assert.equal(result.error, 'path-does-not-exist')
  })
})

test('addRepo becomes the default when it is the first repo registered', () => {
  withTempHome(dir => {
    const repoPath = join(dir, 'repo-a')
    mkdirSync(repoPath, { recursive: true })
    assert.deepEqual(addRepo('repo-a', repoPath), { ok: true, name: 'repo-a', path: repoPath })
    assert.equal(listRepos().default, 'repo-a')
  })
})

test('resolveRepoPath with no name uses the default; with an unknown name it errors clearly', () => {
  withTempHome(dir => {
    const repoPath = join(dir, 'repo-a')
    mkdirSync(repoPath, { recursive: true })
    addRepo('repo-a', repoPath)
    assert.deepEqual(resolveRepoPath(), { ok: true, name: 'repo-a', path: repoPath })
    assert.deepEqual(resolveRepoPath('nonexistent'), { ok: false, error: 'repo-not-found', name: 'nonexistent', retryable: false })
  })
})

test('resolveRepoPath with no name and no repos registered fails clearly instead of guessing', () => {
  withTempHome(() => {
    assert.deepEqual(resolveRepoPath(), { ok: false, error: 'no-repo-specified-and-no-default', retryable: false })
  })
})

test('removeRepo falls the default back to another repo when the current default is removed', () => {
  withTempHome(dir => {
    const pathA = join(dir, 'a')
    const pathB = join(dir, 'b')
    mkdirSync(pathA, { recursive: true })
    mkdirSync(pathB, { recursive: true })
    addRepo('a', pathA)
    addRepo('b', pathB)
    removeRepo('a')
    assert.equal(listRepos().default, 'b')
  })
})

test('setDefaultRepo switches which repo resolveRepoPath() returns with no name given', () => {
  withTempHome(dir => {
    const pathA = join(dir, 'a')
    const pathB = join(dir, 'b')
    mkdirSync(pathA, { recursive: true })
    mkdirSync(pathB, { recursive: true })
    addRepo('a', pathA)
    addRepo('b', pathB)
    setDefaultRepo('b')
    assert.equal(resolveRepoPath().name, 'b')
  })
})
