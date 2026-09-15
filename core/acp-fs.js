// Serves ACP's fs/read_text_file and fs/write_text_file requests (PLAN
// D23) — the agent never touches the filesystem directly; it asks the
// client (this repo) to, and every path is checked against the session's
// registered repo root before any real read/write happens.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname, sep } from 'node:path'

export function assertInsideRepo(repoRoot, requestedPath) {
  const resolvedRoot = resolve(repoRoot)
  const resolvedPath = resolve(requestedPath)
  if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(resolvedRoot + sep)) {
    throw new Error(`path escapes registered repo: ${requestedPath}`)
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
