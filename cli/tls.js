#!/usr/bin/env node
// node cli/tls.js generate   -- create (or report existing) local HTTPS
//                                cert/key for the OAuth redirect callback
// node cli/tls.js path       -- print where the cert/key live
//
// PLAN D55. See core/local-tls.js for why this exists (Slack's public-
// distribution "Use HTTPS For Your Features" check does not exempt
// localhost redirect URLs) and why it's a self-signed cert via the
// system's own openssl rather than a new dependency or Let's Encrypt
// (which cannot certify localhost at all -- it only verifies domains it
// can reach over the public internet).

import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureLocalTlsCert, localTlsPaths } from '../core/local-tls.js'
import { parseFlags, output } from './lib/args.js'

const home = process.env.TSB_HOME || join(homedir(), '.team-slack-bridge')
const command = process.argv[2]
const flags = parseFlags(process.argv.slice(2), ['json'])

let result
if (command === 'generate') {
  result = ensureLocalTlsCert(home)
  if (result.ok && !flags.json) {
    console.error(
      result.generated
        ? `Generated a new self-signed cert at ${result.certPath}.\nYour browser will show a one-time warning the first time it hits https://localhost:8917/callback -- that's expected for a self-signed cert; proceed past it. For a warning-free cert instead, install mkcert (https://mkcert.dev) and point SLACK_LOCAL_TLS_CERT/SLACK_LOCAL_TLS_KEY at its output.`
        : `Existing cert found at ${result.certPath}, left unchanged.`,
    )
  }
} else if (command === 'path') {
  result = { ok: true, ...localTlsPaths(home) }
} else {
  console.error('usage: tls.js <generate|path> [--json]')
  process.exit(1)
}

output(result, { json: flags.json })
