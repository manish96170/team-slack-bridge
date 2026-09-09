// One command that reports which of the eight ways setup can fail is the
// actual problem (PLAN §4.5). Never prints a token VALUE, only whether one
// is present — the remote profile additionally never reports presence or
// the scope set at all (§11.6 #5), since that is fingerprinting for a
// caller who doesn't administer the instance.

import { callSlack } from './slack.js'

export async function doctor({ env, config, profile = 'local' }) {
  if (profile === 'remote') {
    const auth = env.SLACK_BOT_TOKEN ? await callSlack('auth.test', env.SLACK_BOT_TOKEN, {}) : { ok: false }
    return {
      profile: 'remote',
      connected: !!auth.ok,
      postableChannels: config.remote.postableChannels,
      readableChannels: config.remote.readableChannels,
    }
  }

  const report = {
    profile: 'local',
    hasBotToken: !!env.SLACK_BOT_TOKEN,
    hasUserToken: !!env.SLACK_USER_TOKEN,
    hasClientCredentials: !!(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET),
    configuredUsers: config.users.length,
    watchedChannels: config.watchedChannels.length,
    listener: 'not-yet-built',
  }

  if (env.SLACK_BOT_TOKEN) {
    const auth = await callSlack('auth.test', env.SLACK_BOT_TOKEN, {})
    report.botAuth = auth.ok ? { ok: true, team: auth.team, user: auth.user } : { ok: false, error: auth.error }
  }
  if (env.SLACK_USER_TOKEN) {
    const auth = await callSlack('auth.test', env.SLACK_USER_TOKEN, {})
    report.userAuth = auth.ok ? { ok: true, user: auth.user } : { ok: false, error: auth.error }
  }

  return report
}
