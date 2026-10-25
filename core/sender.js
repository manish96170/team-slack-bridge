// Local attribution for bot-sent messages (PLAN D47). The bot token is
// shared infrastructure by design (README's own words: "every user of this
// tool can point at the same Bot Token"), so a message posted with
// SLACK_BOT_TOKEN carries no Slack-native indication of which developer's
// local install sent it — the message just looks like it came from the
// bot/app, to everyone, with no way to tell who ran it. That is the gap a
// shared install across a team can turn into spam with no accountability.
//
// `withSenderAttribution` appends a visible, machine-parseable footer
// naming the install's configured `owner` (slack-config.json), so a human
// reading the channel — or another session reading it back via
// slack_query_messages/slack_get_thread — can resolve a real person (handle
// + Slack member ID) and slack_resolve_user/slack_dm them, rather than the
// message being untraceable.

export function getSenderInfo(config) {
  const slackUserId = config?.owner?.slackUserId || null
  const match = slackUserId ? (config?.users || []).find(u => u.slackUserId === slackUserId) : null
  return {
    slackUserId,
    slackHandle: match?.slackHandle || null,
    name: match?.name || null,
  }
}

// D48 — "authorized" here means this install's config can actually name a
// sender (owner.slackUserId is set). An unidentified install has no one to
// attribute a bot send to and no one to echo a tracking DM to, so a
// `viaBot:true` send from one is refused unless the caller explicitly
// accepts anonymity (`anonymousMessage: true`) — see mcp/tools.local.js.
export function isAuthorizedSender(config) {
  return !!config?.owner?.slackUserId
}

// D49 — `anonymousMessage` has a per-install config default
// (`botSend.anonymousMessageDefault`, off unless set) so an install that
// always wants viaBot sends anonymous doesn't need every caller to
// remember the flag. An explicit per-call value — `true` OR `false` — always
// wins over the config default; only an omitted/undefined argument falls
// back to it.
export function resolveAnonymousMessage(argValue, config) {
  return typeof argValue === 'boolean' ? argValue : !!config?.botSend?.anonymousMessageDefault
}

export function withSenderAttribution(text, config, { anonymous = false } = {}) {
  if (anonymous) return `${text}\n\n_— sent via bot (sender withheld — anonymousMessage:true)_`
  const info = getSenderInfo(config)
  if (!info.slackUserId) {
    return `${text}\n\n_— sent via bot (no owner.slackUserId configured in slack-config.json; this install cannot identify its sender)_`
  }
  const mention = `<@${info.slackUserId}>`
  const label = info.name
    ? ` (${info.name}${info.slackHandle ? `, ${info.slackHandle}` : ''})`
    : info.slackHandle
      ? ` (${info.slackHandle})`
      : ''
  // "memberId: <id>" is deliberately plain text, not just the <@...> mention
  // markup — another session reading this back can regex it out even if the
  // rendering client doesn't expand the mention, then feed it straight into
  // slack_dm/slack_resolve_user.
  return `${text}\n\n_— sent via bot by ${mention}${label} · memberId: ${info.slackUserId}_`
}
