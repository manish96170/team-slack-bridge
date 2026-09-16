// Serves ACP's fs/read_text_file and fs/write_text_file requests (PLAN
// D23) — the agent never touches the filesystem directly; it asks the
// client (this repo) to, and every path is checked against the session's
// registered repo root before any real read/write happens.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { resolve, dirname, sep } from 'node:path'

// resolve() only normalizes the path string — it never touches the
// filesystem. A symlink INSIDE the repo pointing outside it would pass a
// resolve()-only check while actually reading/writing somewhere else
// entirely. This walks up to the deepest ancestor that actually exists
// (the target file itself may not exist yet, e.g. a new file being
// written) and realpath()s THAT, so a symlinked intermediate directory
// gets caught.
function realpathOfExistingAncestor(path) {
  let dir = path
  while (!existsSync(dir)) {
    const parent = dirname(dir)
    if (parent === dir) return dir
    dir = parent
  }
  return realpathSync(dir)
}

export function assertInsideRepo(repoRoot, requestedPath) {
  const resolvedRoot = resolve(repoRoot)
  const resolvedPath = resolve(requestedPath)
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + sep)) {
    throw new Error(`path escapes registered repo: ${requestedPath}`)
  }
  const realRoot = realpathSync(resolvedRoot)
  const realAncestor = realpathOfExistingAncestor(resolvedPath)
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + sep)) {
    throw new Error(`path escapes registered repo via a symlink: ${requestedPath}`)
  }
  return resolvedPath
}

export function createFsHandlers(repoRoot) {
  return {
    async readTextFile({ path, line, limit }) {
      const resolved = assertInsideRepo(repoRoot, path)
      const content = await readFile(resolved, 'utf8')
      if (line == null && limit == null) return { content }
      const lines = content.split('\n')
      const start = line ? line - 1 : 0
      const end = limit ? start + limit : lines.length
      return { content: lines.slice(start, end).join('\n') }
    },
    async writeTextFile({ path, content }) {
      const resolved = assertInsideRepo(repoRoot, path)
      await mkdir(dirname(resolved), { recursive: true })
      await writeFile(resolved, content, 'utf8')
      return {}
    },
  }
}
