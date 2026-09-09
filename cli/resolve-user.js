#!/usr/bin/env node
// node cli/resolve-user.js --handle @jane [--json]

import { resolveUser } from '../core/identity.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['json'])
const { config } = loadContext()

if (!flags.handle) {
  console.error('usage: resolve-user.js --handle <@jane|name|U0123ABC> [--json]')
  process.exit(1)
}

const result = resolveUser(flags.handle, config)

output(result, { json: flags.json })
