// Multi-account listener supervisor (PLAN D75). One process, one Socket Mode
// connection per workspace, each with its own env, config, database and hub.
// createListener() already takes all its state as parameters, so isolation
// between accounts is by construction: nothing here shares a token, a database
// or a session map across accounts.

import { createListener } from '../listen/socket.js'
import { listListenableAccounts, listAccounts } from './accounts.js'
import { loadContextForHome } from '../cli/context.js'

// Pure decision step, separated so it can be reasoned about without sockets:
// which accounts can listen, and why each skipped one was skipped.
export function planListeners({ accounts, load = loadContextForHome }) {
  const plan = []
  const skipped = []
  const seenAppTokens = new Map()
  for (const { name, home } of accounts) {
    const context = load(home)
    const { env, config } = context
    const missing = []
    if (!env.SLACK_BOT_TOKEN) missing.push('SLACK_BOT_TOKEN')
    if (!env.SLACK_APP_TOKEN) missing.push('SLACK_APP_TOKEN')
    if (!config.owner?.slackUserId) missing.push('owner.slackUserId')
    if (missing.length) {
      skipped.push({ name, reason: `missing ${missing.join(', ')}` })
      continue
    }
    // Slack hands each event to ONE of an app's open connections. Two accounts
    // on one app token would steal each other's events, so only the first runs.
    const first = seenAppTokens.get(env.SLACK_APP_TOKEN)
    if (first) {
      skipped.push({ name, reason: `shares an app token with account "${first}" (Slack would split events between them)` })
      continue
    }
    seenAppTokens.set(env.SLACK_APP_TOKEN, name)
    plan.push({ name, home, ...context })
  }
  return { plan, skipped }
}

export function createSupervisor({ accountNames, log = line => console.error(line), onClassified, onError } = {}) {
  const all = listListenableAccounts()
  const wanted = accountNames?.length ? accountNames : null
  if (wanted) {
    const known = Object.keys(listAccounts().accounts)
    const unknown = wanted.filter(name => !known.includes(name))
    if (unknown.length) throw new Error(`unknown account(s): ${unknown.join(', ')}`)
  }
  const candidates = wanted ? all.filter(account => wanted.includes(account.name)) : all
  const { plan, skipped } = planListeners({ accounts: candidates })
  for (const item of skipped) log(`account "${item.name}" not started: ${item.reason}`)

  const running = []
  return {
    plan,
    skipped,
    async start() {
      if (!plan.length) throw new Error('no account can listen (each needs SLACK_BOT_TOKEN, SLACK_APP_TOKEN and an owner)')
      for (const account of plan) {
        const listener = createListener({
          env: account.env,
          botToken: account.env.SLACK_BOT_TOKEN,
          appToken: account.env.SLACK_APP_TOKEN,
          config: account.config,
          configPath: `${account.home}/slack-config.json`,
          dbPath: account.dbPath,
          homeDir: account.home,
          onClassified: result => (onClassified || (() => {}))({ account: account.name, ...result }),
          onError: err => (onError || (() => {}))(account.name, err),
        })
        try {
          await listener.start()
          running.push({ name: account.name, listener })
          log(`account "${account.name}" connected (Socket Mode)`)
        } catch (err) {
          log(`account "${account.name}" failed to connect: ${err.message}`)
        }
      }
      if (!running.length) throw new Error('no account connected')
      return running.map(item => item.name)
    },
    async stop() {
      for (const { listener } of running.splice(0)) await listener.stop().catch(() => {})
    },
  }
}
