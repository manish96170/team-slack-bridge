// Network hub server (PLAN D75/D76). ONE Slack workspace only: host tokens, streams
// and routes are keyed by user id and channel, not by workspace.
//
// Network hub server (PLAN D75): the one process that holds the shared Slack
// app's single Socket Mode connection and forwards each event to the right
// person's machine. It runs no agent and holds no policy: the owner's own host
// still decides (grants, approval cards, sandbox), exactly as in embedded mode.
//
// Routing rule, in one place:
//   start trigger        -> the target's host ("on <person>") or the sender's own
//   reply in a thread    -> the host that reported the session, else the sender's
//   button / owner DM    -> the clicker's / sender's host
// A target whose host is not connected gets an immediate "offline" reply and
// nothing is queued.
//
// Hosts connect OUTBOUND over a long-lived HTTP stream (newline-delimited JSON)
// and report back with POSTs, so no inbound port is needed on a laptop and no
// extra dependency is needed here. Use TLS in front of this server for anything
// beyond localhost.

import { createServer } from 'node:http'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { App } from '@slack/bolt'
import { getDb } from '../db.js'
import { postToChannel } from '../post.js'
import { lookupUser } from '../directory.js'
import { matchesMentionKeyword } from '../acp-sessions.js'
import { parseDelegation } from './commands.js'

const PING_MS = 15_000
const MAX_BODY = 64 * 1024

const sha = value => createHash('sha256').update(value).digest('hex')

export function createHostTokenStore(home) {
  const path = join(home, 'hub-hosts.json')
  const read = () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { hosts: {} })
  const write = data => {
    mkdirSync(home, { recursive: true })
    writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    chmodSync(path, 0o600)
  }
  return {
    // Prints the token ONCE; only its hash is stored.
    addHost(userId) {
      if (!/^[UW][A-Z0-9]{2,}$/.test(userId || '')) return { ok: false, error: 'invalid-user-id' }
      const token = `tsbh_${randomBytes(24).toString('hex')}`
      const data = read()
      for (const [hash, id] of Object.entries(data.hosts)) if (id === userId) delete data.hosts[hash]
      data.hosts[sha(token)] = userId
      write(data)
      return { ok: true, userId, token }
    },
    removeHost(userId) {
      const data = read()
      const before = Object.keys(data.hosts).length
      for (const [hash, id] of Object.entries(data.hosts)) if (id === userId) delete data.hosts[hash]
      write(data)
      return { ok: true, removed: before - Object.keys(data.hosts).length }
    },
    list: () => Object.values(read().hosts),
    authenticate(token) {
      if (!token) return null
      const hash = sha(token)
      for (const [stored, userId] of Object.entries(read().hosts)) {
        const a = Buffer.from(stored)
        const b = Buffer.from(hash)
        if (a.length === b.length && timingSafeEqual(a, b)) return userId
      }
      return null
    },
  }
}

export function createHubServer({ env, config, dbPath, home, port = 8920, host = '127.0.0.1', log = line => console.error(line), onError, createSlackApp }) {
  const tokens = createHostTokenStore(home)
  const streams = new Map() // userId -> { res, ping }
  // A host may only bind a thread the hub itself just forwarded a start to it
  // for (channel match, short window); it can never take over another host's route.
  const expectedStarts = new Map() // hostUserId -> [{ channel, at }]
  const EXPECT_MS = 10 * 60_000
  let httpServer = null
  let slackApp = null
  const botToken = env.SLACK_BOT_TOKEN
  const say = (channel, threadTs, text) => postToChannel({ token: botToken, channel, text, threadTs, config })

  function send(userId, payload) {
    const stream = streams.get(userId)
    if (!stream) return false
    stream.res.write(JSON.stringify(payload) + '\n')
    return true
  }

  const isOnline = userId => streams.has(userId)
  const routeFor = (channel, threadTs) =>
    getDb(dbPath).prepare('SELECT host_user_id FROM thread_routes WHERE channel = ? AND thread_ts = ?').get(channel, threadTs)?.host_user_id || null

  function bodyOf(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', chunk => {
        size += chunk.length
        if (size > MAX_BODY) {
          reject(new Error('body-too-large'))
          req.destroy()
        } else chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  async function handleHttp(req, res) {
    const bearer = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1]
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
      return
    }
    const userId = tokens.authenticate(bearer)
    if (!userId) {
      res.writeHead(401).end()
      return
    }

    if (req.method === 'GET' && req.url === '/host/stream') {
      streams.get(userId)?.res.end()
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache', connection: 'keep-alive' })
      const ping = setInterval(() => res.write('{"type":"ping"}\n'), PING_MS)
      ping.unref?.()
      const entry = { res, ping }
      streams.set(userId, entry)
      res.write(JSON.stringify({ type: 'hello', userId }) + '\n')
      log(`host connected: ${userId}`)
      res.on('close', () => {
        clearInterval(ping)
        if (streams.get(userId) === entry) streams.delete(userId)
        log(`host disconnected: ${userId}`)
      })
      return
    }

    if (req.method === 'POST' && req.url === '/host/report') {
      let data
      try {
        data = JSON.parse(await bodyOf(req))
      } catch {
        res.writeHead(400).end()
        return
      }
      if (data?.type === 'session' && data.channel && data.threadTs) {
        // The reporting host is whoever authenticated; it can never claim a
        // thread for another host.
        const db = getDb(dbPath)
        const existing = db.prepare('SELECT host_user_id FROM thread_routes WHERE channel = ? AND thread_ts = ?').get(String(data.channel), String(data.threadTs))
        const fresh = (expectedStarts.get(userId) || []).filter(item => Date.now() - item.at < EXPECT_MS)
        const index = fresh.findIndex(item => item.channel === String(data.channel))
        const allowed = existing ? existing.host_user_id === userId : index >= 0
        if (!allowed) {
          expectedStarts.set(userId, fresh)
          res.writeHead(403).end()
          return
        }
        if (index >= 0) fresh.splice(index, 1)
        expectedStarts.set(userId, fresh)
        db.prepare(
          `INSERT INTO thread_routes (channel, thread_ts, host_user_id, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(channel, thread_ts) DO NOTHING`
        ).run(String(data.channel), String(data.threadTs), userId, new Date().toISOString())
      }
      res.writeHead(204).end()
      return
    }
    res.writeHead(404).end()
  }

  async function forwardTo(userId, forwarded, { channel, threadTs, label, expectStart }) {
    if (send(userId, { type: 'event', event: forwarded })) {
      if (expectStart) expectedStarts.set(userId, [...(expectedStarts.get(userId) || []), { channel, at: Date.now() }])
      return true
    }
    await say(channel, threadTs, `${label} is offline (their machine is not connected to the hub), so nothing was started.`)
    return false
  }

  async function routeStart({ forwarded, afterKeyword, channel, threadTs, user }) {
    let target = user
    let label = 'Your machine'
    const delegation = parseDelegation(afterKeyword)
    if (delegation) {
      const resolved = delegation.target.userId
        ? { ok: true, userId: delegation.target.userId }
        : await lookupUser({ query: delegation.target.name, mode: 'name', token: botToken, ttlMs: config.directoryLookup?.cacheTtlMs }).then(found =>
            found.ok ? { ok: true, userId: found.user.id } : found
          )
      if (resolved.ok) {
        target = resolved.userId
        label = target === user ? 'Your machine' : `<@${target}>'s machine`
      } else if (delegation.explicit) {
        await say(channel, threadTs, `I could not find anyone called that (${resolved.error}).`)
        return
      }
    }
    await forwardTo(target, forwarded, { channel, threadTs, label, expectStart: true })
  }

  function buildSlackApp() {
    const app = createSlackApp ? createSlackApp() : new App({ token: botToken, appToken: env.SLACK_APP_TOKEN, socketMode: true })
    const stripMention = text => (text || '').replace(/^\s*<@[A-Z0-9]+>\s*/, '')

    app.event('app_mention', async ({ event }) => {
      const afterKeyword = matchesMentionKeyword(stripMention(event.text), config)
      if (afterKeyword === null) return
      await routeStart({ forwarded: { type: 'app_mention', event }, afterKeyword, channel: event.channel, threadTs: event.thread_ts, user: event.user })
    })

    app.message(async ({ message }) => {
      if (message.subtype || message.bot_id || !message.user) return
      const base = { type: 'message', message }
      if (message.channel_type === 'im') {
        const afterKeyword = matchesMentionKeyword(message.text || '', config)
        if (afterKeyword !== null && !message.thread_ts) {
          await routeStart({ forwarded: base, afterKeyword, channel: message.channel, threadTs: message.thread_ts, user: message.user })
          return
        }
      }
      if (message.thread_ts) {
        const owner = routeFor(message.channel, message.thread_ts) || (isOnline(message.user) ? message.user : null)
        if (owner && !send(owner, { type: 'event', event: base })) {
          await say(message.channel, message.thread_ts, 'That session\'s machine is offline right now. Try again when it is back.')
        }
        return
      }
      // An owner typing in their own DM (hub commands, approval answers).
      if (message.channel_type === 'im' && isOnline(message.user)) send(message.user, { type: 'event', event: base })
    })

    app.action(/^(hub_|ask_)/, async ({ action, body, ack }) => {
      await ack()
      const clicker = body.user?.id
      if (clicker) send(clicker, { type: 'event', event: { type: 'action', action, body: { user: body.user, container: body.container } } })
    })

    app.error(err => onError?.(err))
    return app
  }

  return {
    tokens,
    isOnline,
    port: () => httpServer?.address()?.port,
    onlineHosts: () => [...streams.keys()],
    async start() {
      httpServer = createServer((req, res) => {
        handleHttp(req, res).catch(err => {
          onError?.(err)
          if (!res.headersSent) res.writeHead(500).end()
        })
      })
      await new Promise((resolve, reject) => {
        httpServer.once('error', reject)
        httpServer.listen(port, host, resolve)
      })
      if (!env.SLACK_APP_TOKEN || !botToken) throw new Error('hub server needs SLACK_BOT_TOKEN and SLACK_APP_TOKEN')
      slackApp = buildSlackApp()
      await slackApp.start()
      log(`hub server listening on http://${host}:${port}`)
    },
    async stop() {
      for (const { res, ping } of streams.values()) {
        clearInterval(ping)
        res.end()
      }
      streams.clear()
      await slackApp?.stop().catch(() => {})
      await new Promise(resolve => (httpServer ? httpServer.close(resolve) : resolve()))
    },
  }
}
