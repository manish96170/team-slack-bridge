// One command that reports which of the eight ways setup can fail is the
// actual problem (PLAN §4.5). Never prints a token VALUE, only whether one
// is present — the remote profile additionally never reports presence or
// the scope set at all (§11.6 #5), since that is fingerprinting for a
// caller who doesn't administer the instance.

import { callSlack } from './slack.js'
import { getOpenAcpStatus } from './openacp.js'
import { getSlackbotMcpStatus } from './slackbot-mcp.js'

function uniqueChannels(config) {
  return [
    ...(config.watchedChannels || []).map(entry => entry.channel),
    ...(config.remote?.postableChannels || []),
    ...(config.remote?.readableChannels || []),
  ].filter((channel, index, channels) => channel && channels.indexOf(channel) === index)
}

async function findChannelByName(slackCall, token, channelName) {
  const name = channelName.replace(/^#/, '')
  let cursor
  for (let page = 0; page < 10; page++) {
    const result = await slackCall('conversations.list', token, {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    })
    if (!result.ok) return result
    const found = result.channels?.find(channel => channel.name === name)
    if (found) return { ok: true, channel: found }
    cursor = result.response_metadata?.next_cursor
    if (!cursor) break
  }
  return { ok: false, error: 'channel-not-found', retryable: false }
}

async function checkChannel(slackCall, token, configuredChannel) {
  if (!token) return { channel: configuredChannel, ok: false, error: 'no-token' }

  const resolved = configuredChannel.startsWith('#') ? await findChannelByName(slackCall, token, configuredChannel) : { ok: true, channel: { id: configuredChannel } }
  if (!resolved.ok) return { channel: configuredChannel, ok: false, error: resolved.error, retryable: resolved.retryable }

  const info = await slackCall('conversations.info', token, { channel: resolved.channel.id })
  if (!info.ok) return { channel: configuredChannel, id: resolved.channel.id, ok: false, error: info.error, retryable: info.retryable }

  return {
    channel: configuredChannel,
    id: info.channel?.id || resolved.channel.id,
    name: info.channel?.name,
    ok: true,
    isMember: !!info.channel?.is_member,
    isArchived: !!info.channel?.is_archived,
  }
}

export async function doctor({ env, config, profile = 'local', slackCall = callSlack }) {
  if (profile === 'remote') {
    const auth = env.SLACK_BOT_TOKEN ? await slackCall('auth.test', env.SLACK_BOT_TOKEN, {}) : { ok: false }
    return {
      profile: 'remote',
      connected: !!auth.ok,
      postableChannels: config.remote?.postableChannels || [],
      readableChannels: config.remote?.readableChannels || [],
    }
  }

  const report = {
    profile: 'local',
    hasBotToken: !!env.SLACK_BOT_TOKEN,
    hasUserToken: !!env.SLACK_USER_TOKEN,
    hasAppToken: !!env.SLACK_APP_TOKEN,
    hasSigningSecret: !!env.SLACK_SIGNING_SECRET,
    hasClientCredentials: !!(env.SLACK_CLIENT_ID && env.SLACK_CLIENT_SECRET),
    configuredUsers: config.users.length,
    watchedChannels: config.watchedChannels.length,
    outputMode: config.outputMode || 'medium',
    http: {
      enabled: !!config.http?.enabled,
      port: config.http?.port,
      verifiesSlackSignatures: config.http?.verifySlackSignatures !== false,
      ready: !config.http?.enabled || config.http?.verifySlackSignatures === false || !!env.SLACK_SIGNING_SECRET,
    },
    slashCommands: {
      enabled: !!config.slashCommands?.enabled,
      outputModeCommand: config.slashCommands?.outputModeCommand || '/outputmode',
    },
    agentSessions: config.agentSessions,
    openacp: await getOpenAcpStatus(config),
    slackbotMcp: getSlackbotMcpStatus(config),
    listener: {
      configured: !!(env.SLACK_BOT_TOKEN && env.SLACK_APP_TOKEN && config.owner?.slackUserId),
      hasOwner: !!config.owner?.slackUserId,
    },
  }

  if (env.SLACK_BOT_TOKEN) {
    const auth = await slackCall('auth.test', env.SLACK_BOT_TOKEN, {})
    report.botAuth = auth.ok ? { ok: true, team: auth.team, user: auth.user } : { ok: false, error: auth.error }
  }
  if (env.SLACK_USER_TOKEN) {
    const auth = await slackCall('auth.test', env.SLACK_USER_TOKEN, {})
    report.userAuth = auth.ok ? { ok: true, user: auth.user } : { ok: false, error: auth.error }
  }
  if (env.SLACK_APP_TOKEN) {
    const socket = await slackCall('apps.connections.open', env.SLACK_APP_TOKEN, {})
    report.socketMode = socket.ok ? { ok: true } : { ok: false, error: socket.error }
  }

  if (env.SLACK_BOT_TOKEN) {
    report.channels = []
    for (const channel of uniqueChannels(config)) {
      report.channels.push(await checkChannel(slackCall, env.SLACK_BOT_TOKEN, channel))
    }
  }

  return report
}
