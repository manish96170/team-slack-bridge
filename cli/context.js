import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { loadEnv } from '../env.js'
import { loadConfig } from '../core/identity.js'

const HOME_DIR = process.env.TSB_HOME || join(homedir(), '.team-slack-bridge')
export const REPO_ROOT = existsSync(join(HOME_DIR, 'slack-config.json'))
  ? HOME_DIR
  : join(dirname(fileURLToPath(import.meta.url)), '..')
export const CONFIG_PATH = join(REPO_ROOT, 'slack-config.json')
export const LEDGER_PATH = join(HOME_DIR, '.ledger.sqlite')

export function loadContext() {
  return { env: loadEnv(), config: loadConfig(CONFIG_PATH) }
}
