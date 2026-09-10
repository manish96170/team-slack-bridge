import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadEnv } from '../env.js'
import { loadConfig } from '../core/identity.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = join(__dirname, '..')
export const CONFIG_PATH = join(REPO_ROOT, 'slack-config.json')
export const LEDGER_PATH = join(REPO_ROOT, '.ledger.sqlite')

export function loadContext() {
  return { env: loadEnv(), config: loadConfig(CONFIG_PATH) }
}
