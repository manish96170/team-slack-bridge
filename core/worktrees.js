// Per-session git worktrees (PLAN D75). Two sessions on one repo would
// otherwise edit the same checkout. A session gets its own detached worktree
// under <home>/worktrees/, and the agent's file and terminal scope is that
// worktree, not the original repo. Closing a session removes its worktree only
// when it holds no work: anything uncommitted or newly committed is kept, and
// the path is reported so nothing is ever deleted silently.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

export function isGitRepo(path) {
  try {
    return git(path, ['rev-parse', '--is-inside-work-tree']) === 'true'
  } catch {
    return false
  }
}

export function createWorktree({ repoPath, repoName, sessionKey, home }) {
  if (!isGitRepo(repoPath)) return { ok: false, error: 'not-a-git-repo' }
  const safe = String(sessionKey).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40)
  const root = join(home, 'worktrees')
  const path = join(root, `${repoName}-${safe}`)
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    if (!existsSync(path)) git(repoPath, ['worktree', 'add', '--detach', path, 'HEAD'])
    return { ok: true, path: realpathSync(path), base: git(path, ['rev-parse', 'HEAD']), origin: repoPath }
  } catch (err) {
    return { ok: false, error: `worktree-failed: ${String(err.stderr || err.message).trim().slice(0, 200)}` }
  }
}

export function removeWorktreeIfClean({ path, origin, base }) {
  if (!path || !existsSync(path)) return { ok: true, removed: false, reason: 'already-gone' }
  try {
    const dirty = git(path, ['status', '--porcelain']).length > 0
    const moved = git(path, ['rev-parse', 'HEAD']) !== base
    if (dirty || moved) return { ok: true, removed: false, kept: path, reason: dirty ? 'uncommitted-changes' : 'new-commits' }
    git(origin, ['worktree', 'remove', path])
    return { ok: true, removed: true }
  } catch (err) {
    return { ok: false, removed: false, error: String(err.stderr || err.message).trim().slice(0, 200) }
  }
}
