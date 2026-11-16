// Multi-account listener supervisor (PLAN D75). One process, one Socket Mode
// connection per workspace, each with its own env, config, database and hub.
// createListener() already takes all its state as parameters, so isolation
// between accounts is by construction: nothing here shares a token, a database
// or a session map across accounts.

import { createListener } from '../listen/socket.js'
import { listListenableAccounts, listAccounts } from './accounts.js'
import { loadContextForHome } from '../cli/context.js'
import { App } from '@slack/bolt'
import { createVirtualApp } from './hub/virtual-app.js'
import { callSlack } from './slack.js'

// Pure decision step, separated so it can be reasoned about without sockets:
// which accounts can listen, and why each skipped one was skipped.
export function planListeners({ accounts, load = loadContextForHome }) {
  const plan = []
  const skipped = []
  const seenAppTokens = new Map()
  const loaded = accounts.map(({ name, home }) => ({ name, home, context: load(home) }))
  // The same Slack app installed in two workspaces has one app-level token but
  // a bot token per workspace. An account with no app token of its own borrows
  // the one from an account with the same OAuth client id (same app).
  const appTokenByClient = new Map()
  for (const { context } of loaded) {
    const { SLACK_CLIENT_ID: client, SLACK_APP_TOKEN: token } = context.env
    if (client && token && !appTokenByClient.has(client)) appTokenByClient.set(client, token)
  }
  for (const { name, home, context } of loaded) {
    const { env, config } = context
    if (!env.SLACK_APP_TOKEN && env.SLACK_CLIENT_ID && appTokenByClient.has(env.SLACK_CLIENT_ID)) {
      env.SLACK_APP_TOKEN = appTokenByClient.get(env.SLACK_CLIENT_ID)
      context.borrowedAppToken = true
    }
    const missing = []
    if (!env.SLACK_BOT_TOKEN) missing.push('SLACK_BOT_TOKEN')
    if (!env.SLACK_APP_TOKEN) missing.push('SLACK_APP_TOKEN')
    if (!config.owner?.slackUserId) missing.push('owner.slackUserId')
    if (missing.length) {
      skipped.push({ name, reason: `missing ${missing.join(', ')}` })
      continue
    }
    // Accounts that share an app token are workspaces where the SAME Slack app is
    // installed. They share ONE Socket Mode connection (Slack splits an app's
    // events across connections, so a second connection would steal events);
    // events are routed to the right account by workspace id (see start()).
    const first = seenAppTokens.get(env.SLACK_APP_TOKEN)
    seenAppTokens.set(env.SLACK_APP_TOKEN, first || name)
    plan.push({ name, home, appGroup: first || name, ...context })
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
      const groups = new Map()
      for (const account of plan) groups.set(account.appGroup, [...(groups.get(account.appGroup) || []), account])

      for (const members of groups.values()) {
        if (members.length === 1) {
          const account = members[0]
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
          continue
        }
        try {
          const shared = await startSharedApp({ members, log, onClassified, onError })
          for (const name of shared.names) running.push({ name, listener: shared })
          log(`accounts ${shared.names.map(name => `"${name}"`).join(', ')} share one Socket Mode connection`)
        } catch (err) {
          log(`shared app for ${members.map(member => `"${member.name}"`).join(', ')} failed: ${err.message}`)
        }
      }
      if (!running.length) throw new Error('no account connected')
      return running.map(item => item.name)
    },
    async stop() {
      const seen = new Set()
      for (const { listener } of running.splice(0)) {
        if (seen.has(listener)) continue
        seen.add(listener)
        await listener.stop().catch(() => {})
      }
    },
  }
}

const teamOf = body => body?.team_id || body?.team?.id || body?.view?.team_id || body?.user?.team_id || body?.authorizations?.[0]?.team_id

// One real Socket Mode connection for several workspaces of the same Slack app.
// Each workspace is an ordinary account behind a virtual app, so its sessions,
// hub, database and tokens are exactly what a single-account listener would
// have. Events are routed by workspace id; an event for an unknown workspace is
// dropped, never handed to another account.
async function startSharedApp({ members, log, onClassified, onError }) {
  const byTeam = new Map()
  for (const account of members) {
    const auth = await callSlack('auth.test', account.env.SLACK_BOT_TOKEN, {})
    if (!auth.ok) {
      log(`account "${account.name}" skipped: auth.test failed (${auth.error})`)
      continue
    }
    if (byTeam.has(auth.team_id)) {
      log(`account "${account.name}" skipped: workspace ${auth.team_id} is already served by "${byTeam.get(auth.team_id).account.name}"`)
      continue
    }
    const virtual = createVirtualApp()
    const listener = createListener({
      env: account.env,
      botToken: account.env.SLACK_BOT_TOKEN,
      appToken: null,
      config: account.config,
      configPath: `${account.home}/slack-config.json`,
      dbPath: account.dbPath,
      homeDir: account.home,
      app: virtual,
      onClassified: result => (onClassified || (() => {}))({ account: account.name, ...result }),
      onError: err => (onError || (() => {}))(account.name, err),
    })
    byTeam.set(auth.team_id, { account, virtual, listener, botUserId: auth.user_id, botId: auth.bot_id })
  }
  if (!byTeam.size) throw new Error('no account authenticated')

  const app = new App({
    appToken: members[0].env.SLACK_APP_TOKEN,
    socketMode: true,
    authorize: async ({ teamId }) => {
      const entry = byTeam.get(teamId)
      if (!entry) throw new Error(`no account for workspace ${teamId}`)
      return { botToken: entry.account.env.SLACK_BOT_TOKEN, botUserId: entry.botUserId, botId: entry.botId, teamId }
    },
  })
  const route = (body, forwarded) => byTeam.get(teamOf(body))?.virtual.dispatch(forwarded)

  app.event('app_mention', async ({ event, body }) => route(body, { type: 'app_mention', event }))
  app.message(async ({ message, body }) => route(body, { type: 'message', message }))
  app.action(/.*/, async ({ action, body, ack }) => {
    await ack()
    await route(body, { type: 'action', action, body })
  })
  for (const name of ['app_home_opened', 'user_huddle_changed']) {
    app.event(name, async ({ event, body }) => route(body, { type: 'event', name, event, body }))
  }
  for (const name of ['/outputmode', '/agent-session']) {
    app.command(name, async payload => route(payload.body, { type: 'command', name, payload }))
  }
  app.shortcut('start_agent_session', async payload => route(payload.body, { type: 'shortcut', id: 'start_agent_session', payload }))
  app.view('start_agent_session_modal', async payload => route(payload.body, { type: 'view', id: 'start_agent_session_modal', payload }))
  app.error(err => onError?.('shared', err))

  const started = []
  for (const entry of byTeam.values()) {
    await entry.listener.start()
    started.push(entry)
  }
  await app.start()
  return {
    names: [...byTeam.values()].map(entry => entry.account.name),
    stop: async () => {
      await app.stop().catch(() => {})
      for (const entry of started) await entry.listener.stop().catch(() => {})
    },
  }
}
