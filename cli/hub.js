#!/usr/bin/env node
// node cli/hub.js grants|grant|revoke|block|unblock|resign|status [--json]
//
// The owner's local interface to the hub policy (PLAN D74): the same grants the
// Slack `hub ...` commands manage, for when you are at the machine. Run it as
// yourself in a terminal; delegated sessions run under a sandbox that denies the
// bridge's home directory, so an agent cannot use this to change its own access.

import { createPolicyStore, GRANT_LEVELS } from '../core/hub/policy.js'
import { extractUserId } from '../core/hub/commands.js'
import { listRepos } from '../core/repos.js'
import { loadConfig } from '../core/identity.js'
import { parseFlags } from './lib/args.js'
import { CONFIG_PATH, HOME_DIR } from './context.js'

const [command, ...rest] = process.argv.slice(2)
const flags = parseFlags(process.argv.slice(3), ['json'])
const positional = rest.filter((item, index) => !item.startsWith('--') && !(rest[index - 1] || '').startsWith('--'))

const config = loadConfig(CONFIG_PATH)
const ownerId = config.owner?.slackUserId
if (!ownerId) {
  console.error('No owner configured — run: node cli/setup.js set-owner --user <U0123ABC>')
  process.exit(1)
}

const store = createPolicyStore({ home: HOME_DIR, ownerId })
const userId = extractUserId(positional[0])
const repos = flags.repo ? flags.repo.split(',').map(item => item.trim()).filter(Boolean) : []

function print(result) {
  if (flags.json) console.log(JSON.stringify(result))
  else if (!result.ok) console.error(`Error: ${result.error}`)
  else console.log('OK')
  process.exitCode = result.ok ? 0 : 1
}

if (command === 'status') {
  const listed = store.list()
  const summary = listed.ok
    ? { ok: true, enabled: config.hub.enabled, keySource: store.keySource, grants: Object.keys(listed.policy.grants).length, blocked: Object.keys(listed.policy.blocked).length }
    : { ok: false, error: listed.error }
  if (flags.json) console.log(JSON.stringify(summary))
  else console.log(summary.ok ? `hub ${summary.enabled ? 'enabled' : 'disabled'} · key in ${summary.keySource} · ${summary.grants} user(s) with grants · ${summary.blocked} blocked` : `policy unavailable: ${summary.error}`)
  process.exitCode = summary.ok ? 0 : 1
} else if (command === 'grants') {
  const listed = store.list()
  if (!listed.ok) print(listed)
  else if (flags.json) console.log(JSON.stringify({ ok: true, grants: listed.policy.grants, blocked: listed.policy.blocked }))
  else {
    for (const [user, byRepo] of Object.entries(listed.policy.grants)) {
      console.log(`${user}: ${Object.entries(byRepo).map(([repo, grant]) => `${repo} (${grant.level}${grant.expiresAt ? ` until ${grant.expiresAt}` : ''})`).join(', ')}`)
    }
    for (const user of Object.keys(listed.policy.blocked)) console.log(`${user}: BLOCKED`)
    if (!Object.keys(listed.policy.grants).length && !Object.keys(listed.policy.blocked).length) console.log('No grants and no blocked users.')
  }
} else if (command === 'grant') {
  const known = Object.keys(listRepos().repos)
  const unknown = repos.filter(repo => !known.includes(repo))
  if (!userId || !repos.length) print({ ok: false, error: 'usage: grant <U0123ABC> --repo a,b [--level always|ask|readonly] [--expires 7d]' })
  else if (unknown.length) print({ ok: false, error: `unknown repo(s): ${unknown.join(', ')} (registered: ${known.join(', ') || 'none'})` })
  else if (flags.level && !GRANT_LEVELS.includes(flags.level)) print({ ok: false, error: `level must be one of ${GRANT_LEVELS.join(', ')}` })
  else print(store.grant({ userId, repos, level: flags.level || config.hub.defaultGrantLevel, expires: flags.expires, by: ownerId }))
} else if (command === 'revoke') {
  print(userId ? store.revoke({ userId, repos, by: ownerId }) : { ok: false, error: 'usage: revoke <U0123ABC> [--repo a,b]' })
} else if (command === 'block') {
  print(userId ? store.block({ userId, by: ownerId }) : { ok: false, error: 'usage: block <U0123ABC>' })
} else if (command === 'unblock') {
  print(userId ? store.unblock({ userId, by: ownerId }) : { ok: false, error: 'usage: unblock <U0123ABC>' })
} else if (command === 'resign') {
  print(store.resign())
} else {
  console.error('usage: hub.js status|grants|grant|revoke|block|unblock|resign [--json]')
  process.exit(1)
}
