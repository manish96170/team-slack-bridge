#!/usr/bin/env node
// node cli/hub-server.js start [--port 8920] [--host 127.0.0.1]
// node cli/hub-server.js add-host <U0123ABC>      prints that person's host token ONCE
// node cli/hub-server.js remove-host <U0123ABC>
// node cli/hub-server.js hosts
//
// The network hub (PLAN D75): holds the shared Slack app's one Socket Mode
// connection and forwards events to each person's connected machine. Put TLS in
// front of it before exposing it beyond localhost.

import { createHubServer } from '../core/hub/network.js'
import { createHostTokenStore } from '../core/hub/network.js'
import { parseFlags } from './lib/args.js'
import { HOME_DIR, loadContext, LEDGER_PATH } from './context.js'

const [command, arg] = process.argv.slice(2)
const flags = parseFlags(process.argv.slice(3), [])
const { env, config } = loadContext()

if (command === 'add-host' || command === 'remove-host' || command === 'hosts') {
  const tokens = createHostTokenStore(HOME_DIR)
  if (command === 'hosts') console.log(tokens.list().join('\n') || 'No hosts registered.')
  else if (command === 'add-host') {
    const result = tokens.addHost(arg)
    if (!result.ok) {
      console.error(`Error: ${result.error}`)
      process.exit(1)
    }
    console.log(`Host token for ${result.userId} (shown once, store it on that machine only):\n${result.token}`)
  } else console.log(JSON.stringify(tokens.removeHost(arg)))
} else if (command === 'start') {
  const server = createHubServer({
    env,
    config,
    dbPath: LEDGER_PATH,
    home: HOME_DIR,
    port: flags.port ? Number(flags.port) : 8920,
    host: flags.host || '127.0.0.1',
    onError: err => console.error(`hub error: ${err.message}`),
  })
  await server.start()
  const shutdown = async () => {
    await server.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} else {
  console.error('usage: hub-server.js start [--port n] [--host h] | add-host <U…> | remove-host <U…> | hosts')
  process.exit(1)
}
