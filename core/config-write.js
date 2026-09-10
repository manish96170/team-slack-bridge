import { writeFileSync } from 'node:fs'

export function setOutputModeInConfig({ config, configPath, outputMode }) {
  if (!configPath) return { ok: false, error: 'config-path-required', retryable: false }
  if (!['low', 'medium', 'high'].includes(outputMode)) {
    return { ok: false, error: 'outputMode-must-be-low-medium-or-high', retryable: false }
  }
  const next = { ...config, outputMode }
  writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n')
  return { ok: true, outputMode }
}
