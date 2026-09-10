import { postToChannel, updateMessage } from './post.js'

export function renderProgress({ label = 'Working', status = 'running', detail, outputMode = 'medium' }) {
  if (outputMode === 'low') return `*${label}* — ${status}`
  const suffix = detail ? `\n${detail}` : ''
  if (outputMode === 'high') return `*${label}* — ${status}${suffix}\n_mode: high_`
  return `*${label}* — ${status}${suffix}`
}

export async function startProgress({ token, channel, label, detail, threadTs, idempotencyKey, ledgerPath, config, dryRun }) {
  return postToChannel({
    token,
    channel,
    threadTs,
    text: renderProgress({ label, status: 'started', detail, outputMode: config?.outputMode }),
    idempotencyKey,
    ledgerPath,
    config,
    dryRun,
  })
}

export async function updateProgress({ token, channel, ts, label, status = 'running', detail, ledgerPath, config, dryRun }) {
  return updateMessage({
    token,
    channel,
    ts,
    text: renderProgress({ label, status, detail, outputMode: config?.outputMode }),
    ledgerPath,
    config,
    dryRun,
  })
}

export async function finishProgress({ token, channel, ts, label, detail, ok = true, ledgerPath, config, dryRun }) {
  return updateProgress({
    token,
    channel,
    ts,
    label,
    status: ok ? 'done' : 'failed',
    detail,
    ledgerPath,
    config,
    dryRun,
  })
}
