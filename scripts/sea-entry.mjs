// Node SEA entry point for `npm run build:sea`. Kept as an async main() rather
// than the top-level await in post.js, since SEA's main script runs as CJS.
import { loadEnv } from '../env.js'
import { postToChannel } from '../core/post.js'
import { dm } from '../core/dm.js'
import { loadConfig } from '../core/identity.js'
import { parseFlags, output } from '../cli/lib/args.js'
import { LEDGER_PATH, CONFIG_PATH } from '../cli/context.js'

async function main() {
  const flags = parseFlags(process.argv.slice(2), ['as-user', 'dry-run', 'json'])
  const env = loadEnv()
  const config = loadConfig(CONFIG_PATH)

  if (!flags.text) {
    console.error('--text is required')
    process.exit(1)
  }
  if (!flags.channel && !flags.dm) {
    console.error('one of --channel or --dm is required')
    process.exit(1)
  }

  const result = flags.dm
    ? await dm({
        botToken: env.SLACK_BOT_TOKEN,
        userToken: env.SLACK_USER_TOKEN,
        userId: flags.dm,
        text: flags.text,
        asUser: flags['as-user'],
        config,
        dbPath: LEDGER_PATH,
        dryRun: flags['dry-run'],
      })
    : await postToChannel({
        token: flags['as-user'] ? env.SLACK_USER_TOKEN : env.SLACK_BOT_TOKEN,
        channel: flags.channel,
        text: flags.text,
        threadTs: flags['thread-ts'],
        idempotencyKey: flags['idempotency-key'],
        ledgerPath: LEDGER_PATH,
        config,
        dryRun: flags['dry-run'],
      })

  if (flags.json) {
    output(result, { json: true })
  } else if (!result.ok) {
    console.error(result.error)
    process.exitCode = 1
  } else if (result.dryRun) {
    console.log(`[dry-run] would post ${flags['as-user'] ? 'as user' : 'as bot'} to ${flags.dm ? `DM ${flags.dm}` : flags.channel}.`)
  } else {
    console.log(`Posted ${flags['as-user'] ? 'as user' : 'as bot'} to ${flags.dm ? `DM ${flags.dm}` : flags.channel}.`)
  }
}

main()
