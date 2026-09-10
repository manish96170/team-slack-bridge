#!/usr/bin/env node
// node cli/doctor.js [--json]

import { doctor } from '../core/doctor.js'
import { parseFlags, output } from './lib/args.js'
import { loadContext } from './context.js'

const flags = parseFlags(process.argv.slice(2), ['json'])
const { env, config } = loadContext()

const report = await doctor({ env, config, profile: 'local' })

output({ ok: true, ...report }, { json: flags.json })
