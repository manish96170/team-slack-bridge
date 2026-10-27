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

// Footer format (on request, 2026-10-27): plain name first, "(@handle, memberId)"
// second, a bold "no-reply" marker last — e.g.
//   "— sent via bot by Manish Sharma (@manish.sharma, U055NFSGF88) *no-reply*"
// `*no-reply*` is Slack mrkdwn bold (single asterisks, not markdown's **),
// since this text is sent as a chat.postMessage `text` body, not rendered
// through a markdown processor — it tells the recipient a reply here goes
// to the shared bot, not necessarily straight back to the named human.
// The Slack ID stays plain text (never only inside `<@...>` mention markup)
// so another session reading this back via slack_query_messages/
// slack_get_thread can still regex it out and feed it straight into
// slack_dm/slack_resolve_user, even if the rendering client doesn't expand
// a mention — just no longer under an explicit "memberId:" label.
export function withSenderAttribution(text, config, { anonymous = false } = {}) {
  if (anonymous) return `${text}\n\n_— sent via bot (sender withheld — anonymousMessage:true) *no-reply*_`
  const info = getSenderInfo(config)
  if (!info.slackUserId) {
    return `${text}\n\n_— sent via bot (no owner.slackUserId configured in slack-config.json; this install cannot identify its sender) *no-reply*_`
  }
  const who = info.name || info.slackHandle || info.slackUserId
  // Only include a field in the parens if it isn't already the "who" above
  // — otherwise a sender with no configured name but a handle would read
  // "by @handle (@handle, U123)", repeating itself.
  const parens = [info.name ? info.slackHandle : null, who !== info.slackUserId ? info.slackUserId : null].filter(Boolean).join(', ')
  return `${text}\n\n_— sent via bot by ${who}${parens ? ` (${parens})` : ''} *no-reply*_`
}
