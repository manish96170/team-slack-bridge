// Single source of truth for "what version is this install" — every
// surface that reports a version (MCP serverInfo, the App Home tab) reads
// package.json directly instead of carrying its own hardcoded string that
// drifts the moment a release bumps the version and this doesn't.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let cached

export function packageVersion() {
  if (cached !== undefined) return cached
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    cached = JSON.parse(readFileSync(pkgPath, 'utf8')).version || null
  } catch {
    cached = null
  }
  return cached
}
