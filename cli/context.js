import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { loadEnv } from '../env.js'
import { loadConfig } from '../core/identity.js'
import { resolveAccountHome } from '../core/accounts.js'

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Resolve "which home directory" through core/accounts.js's registry (D21)
// instead of a raw TSB_HOME-only read, so `cli/accounts.js set-default
// <name>` applies the SAME WAY to every surface — every cli/*.js command,
// the stdio MCP server (mcp/server.js), and the HTTP daemon's single-account
// mode — not just the already account-aware functions that take an explicit
// name (resolveAccountHome/loadAccountContext, cli/accounts.js,
// cli/dm-by-name.js, localMcpDaemon's "multi" mode). D21's own guarantee
// still holds for anyone who never touches the registry:
// resolveAccountHome() with no accounts.json synthesizes a single "default"
// account pointing at exactly the same TSB_HOME-or-homedir path this file
// always computed directly, so this is byte-identical for an untouched
// install (D66, found live: a registered default of "anchor" had no effect
// on mcp/server.js or any other cli/*.js command, only on the account-aware
// functions above — this closes that gap).
const resolvedAccount = resolveAccountHome()
export const HOME_DIR = resolvedAccount.ok ? resolvedAccount.home : process.env.TSB_HOME || join(homedir(), '.team-slack-bridge')
// Default to TSB_HOME for any new setup — an npm-installed copy must never
// need to write inside its own install directory, since `npm update` wipes
// it. The package-relative path is only a legacy fallback for existing
// git-clone installs that already have a slack-config.json there from
// before TSB_HOME existed.
export const REPO_ROOT =
  !existsSync(join(HOME_DIR, 'slack-config.json')) && existsSync(join(PACKAGE_ROOT, 'slack-config.json')) ? PACKAGE_ROOT : HOME_DIR
export const CONFIG_PATH = join(REPO_ROOT, 'slack-config.json')
export const LEDGER_PATH = join(HOME_DIR, '.ledger.sqlite')

export function loadContext() {
  // Keep config and credentials paired: if a legacy package-root
  // slack-config.json is selected, read that package root's .env too; for
  // every normal account-aware path read that account home's .env. Passing
  // undefined here would let env.js independently re-resolve raw TSB_HOME,
  // which can belong to a different account after D66 selected a registered
  // default home.
  return { env: loadEnv(REPO_ROOT), config: loadConfig(CONFIG_PATH), dbPath: LEDGER_PATH }
}

// Multi-account path only (core/accounts.js) — every existing caller keeps
// using loadContext()/CONFIG_PATH/LEDGER_PATH above, unchanged.
export function loadContextForHome(homeDir) {
  return { env: loadEnv(homeDir), config: loadConfig(join(homeDir, 'slack-config.json')), dbPath: join(homeDir, '.ledger.sqlite') }
}
