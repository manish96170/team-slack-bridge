import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const HOME_DIR = process.env.TSB_HOME || join(homedir(), '.team-slack-bridge')
const PACKAGE_ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '.env')
// Default to TSB_HOME for any new setup (npm-installed copies must never
// need to write inside their own install directory — `npm update` wipes
// it). The package-relative path is only used as a legacy fallback for
// existing git-clone installs that already have a .env there from before
// TSB_HOME existed.
const ENV_PATH = !existsSync(join(HOME_DIR, '.env')) && existsSync(PACKAGE_ENV_PATH) ? PACKAGE_ENV_PATH : join(HOME_DIR, '.env')

function readEnvFile(path) {
  const env = {}
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx === -1) continue
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1)
    }
  }
  return env
}

// `homeDir` is for the multi-account path (core/accounts.js) only — every
// existing caller omits it and keeps reading from TSB_HOME/~/.team-slack-bridge
// exactly as before.
export function loadEnv(homeDir) {
  return readEnvFile(homeDir ? join(homeDir, '.env') : ENV_PATH)
}

export const ENV_FILE_PATH = ENV_PATH
