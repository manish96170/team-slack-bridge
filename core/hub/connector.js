// Host connector (PLAN D75): runs on a developer's machine, dials OUT to the
// network hub, and replays the events the hub forwards into an ordinary
// listener built on a virtual app. Sessions, grants, approval cards and the
// sandbox are the same code as embedded mode; only the event source differs.

import { createListener } from '../../listen/socket.js'
import { createVirtualApp } from './virtual-app.js'
import { setSessionObserver } from './registry.js'

const STALL_MS = 45_000

function assertSafeUrl(url, allowInsecure) {
  const parsed = new URL(url)
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !local && !allowInsecure) {
    throw new Error('hub url must be https (or localhost); pass allowInsecure only for a trusted private network')
  }
  return parsed.origin
}

export function createConnector({ hubUrl, hostToken, env, config, dbPath, homeDir, allowInsecure = false, log = line => console.error(line), onClassified, onError }) {
  const origin = assertSafeUrl(hubUrl, allowInsecure)
  if (!config.owner?.slackUserId) throw new Error('connector needs owner.slackUserId (the Slack user this machine belongs to)')
  const app = createVirtualApp()
  const listener = createListener({
    env,
    botToken: env.SLACK_BOT_TOKEN,
    appToken: null,
    config,
    dbPath,
    homeDir,
    app,
    onClassified: onClassified || (() => {}),
    onError: onError || (err => log(`listener error: ${err.message}`)),
  })
  let stopped = false
  let controller = null

  const headers = { authorization: `Bearer ${hostToken}` }

  async function report(info) {
    try {
      await fetch(`${origin}/host/report`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'session', ...info }) })
    } catch (err) {
      log(`could not report session route: ${err.message}`)
    }
  }

  async function consume() {
    controller = new AbortController()
    let lastData = Date.now()
    const watchdog = setInterval(() => {
      if (Date.now() - lastData > STALL_MS) controller.abort()
    }, 5_000)
    watchdog.unref?.()
    try {
      const response = await fetch(`${origin}/host/stream`, { headers, signal: controller.signal })
      if (response.status === 401) throw Object.assign(new Error('hub rejected this host token'), { fatal: true })
      if (!response.ok || !response.body) throw new Error(`hub returned ${response.status}`)
      const decoder = new TextDecoder()
      let buffer = ''
      for await (const chunk of response.body) {
        lastData = Date.now()
        buffer += decoder.decode(chunk, { stream: true })
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line) continue
          let message
          try {
            message = JSON.parse(line)
          } catch {
            continue
          }
          if (message.type === 'hello') log(`connected to hub as ${message.userId}`)
          else if (message.type === 'event') {
            app.dispatch(message.event).catch(err => log(`event failed: ${err.message}`))
          }
        }
      }
    } finally {
      clearInterval(watchdog)
    }
  }

  return {
    async start() {
      await listener.start()
      setSessionObserver(dbPath, report)
      void (async () => {
        let delay = 1_000
        while (!stopped) {
          try {
            await consume()
            delay = 1_000
          } catch (err) {
            if (stopped) break
            if (err.fatal) {
              log(err.message)
              break
            }
            log(`hub connection lost: ${err.message}; retrying in ${Math.round(delay / 1000)}s`)
          }
          await new Promise(resolve => setTimeout(resolve, delay))
          delay = Math.min(delay * 2, 30_000)
        }
      })()
    },
    async stop() {
      stopped = true
      setSessionObserver(dbPath, null)
      controller?.abort()
      await listener.stop()
    },
  }
}
