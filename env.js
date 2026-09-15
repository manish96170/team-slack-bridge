import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const HOME_DIR = process.env.TSB_HOME || join(homedir(), '.team-slack-bridge')
const ENV_PATH = existsSync(join(HOME_DIR, '.env'))
  ? join(HOME_DIR, '.env')
  : join(dirname(fileURLToPath(import.meta.url)), '.env')

export function loadEnv() {
  const env = {}
  if (existsSync(ENV_PATH)) {
    for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx === -1) continue
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1)
    }
  }
  return env
}

export const ENV_FILE_PATH = ENV_PATH
