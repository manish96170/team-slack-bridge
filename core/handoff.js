// Handoff files let a session near its context limit hand off a summary to
// whichever session picks up after it (PLAN: context-limit handoff). Lives
// under the same TSB_HOME root as repos.json/accounts.json (core/repos.js,
// core/accounts.js) rather than inside any repo, since it's bridge-owned
// bookkeeping, not something an agent session should be able to touch via
// its own repo-scoped fs access.

import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

function rootHome() {
  return process.env.TSB_HOME || join(homedir(), '.team-slack-bridge')
}

export function getHandoffsDir() {
  return join(rootHome(), 'handoffs')
}

export function writeHandoffFile({ repoName, summary }) {
  const dir = getHandoffsDir()
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(dir, `handoff-${repoName}-${stamp}-${randomUUID().slice(0, 8)}.md`)
  writeFileSync(path, summary || '(no summary produced)')
  return path
}
