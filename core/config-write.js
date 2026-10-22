import { writeFileSync, chmodSync } from 'node:fs'

export function setOutputModeInConfig({ config, configPath, outputMode }) {
  if (!configPath) return { ok: false, error: 'config-path-required', retryable: false }
  if (!['low', 'medium', 'high'].includes(outputMode)) {
    return { ok: false, error: 'outputMode-must-be-low-medium-or-high', retryable: false }
  }
  const next = { ...config, outputMode }
  writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  // `{ mode }` only takes effect on creation — chmod explicitly so a
  // pre-existing world-readable slack-config.json self-heals here too.
  chmodSync(configPath, 0o600)
  return { ok: true, outputMode }
}
