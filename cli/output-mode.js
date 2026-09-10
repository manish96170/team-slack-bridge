#!/usr/bin/env node
// node cli/output-mode.js [low|medium|high] [--json]

import { CONFIG_PATH, loadContext } from './context.js'
import { setOutputModeInConfig } from '../core/config-write.js'
import { parseFlags, output } from './lib/args.js'

const [mode] = process.argv.slice(2).filter(arg => !arg.startsWith('--'))
const flags = parseFlags(process.argv.slice(2), ['json'])
const { config } = loadContext()

if (!mode) {
  output({ ok: true, outputMode: config.outputMode }, { json: flags.json })
} else {
  output(setOutputModeInConfig({ config, configPath: CONFIG_PATH, outputMode: mode }), { json: flags.json })
}
