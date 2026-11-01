// Slack message-link parsing (D72). A pasted permalink such as
//   https://example.slack.com/archives/C0123ABCD/p1793337025613279
//   https://example.slack.com/archives/C0123ABCD/p1792464941333049?thread_ts=1792464941.333049&cid=C0123ABCD
// already names the conversation and the message, so a caller should not
// have to hand-split it into a channel ID and a dotted timestamp. Pure and
// offline: it never calls Slack and never decides which workspace/account
// the link belongs to — it only reports `workspaceDomain` so the caller can
// verify that against the account it is about to use.

const SLACK_HOST = /(^|\.)slack(-gov)?\.com$/i

// Slack renders links as <https://…|label> in mrkdwn; tolerate pasting that.
function unwrapMrkdwn(input) {
  const trimmed = String(input).trim()
  const match = trimmed.match(/^<([^|>]+)(?:\|[^>]*)?>$/)
  return match ? match[1] : trimmed
}

function dottedTs(digits) {
  return `${digits.slice(0, 10)}.${digits.slice(10)}`
}

export function parseSlackLink(input) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, error: 'link-required', retryable: false }

  let url
  try {
    url = new URL(unwrapMrkdwn(input))
  } catch {
    return { ok: false, error: 'invalid-slack-link', retryable: false }
  }
  if (url.protocol !== 'https:' || !SLACK_HOST.test(url.hostname)) {
    return { ok: false, error: 'not-a-slack-link', retryable: false }
  }

  const match = url.pathname.match(/^\/archives\/([A-Z0-9]+)(?:\/p(\d{16}))?\/?$/)
  if (!match) return { ok: false, error: 'unsupported-slack-link-shape', retryable: false }

  const [, channel, digits] = match
  const ts = digits ? dottedTs(digits) : undefined
  const threadParam = url.searchParams.get('thread_ts')
  const threadTs = threadParam && /^\d{10}\.\d{6}$/.test(threadParam) ? threadParam : ts

  return {
    ok: true,
    workspaceDomain: url.hostname,
    channel,
    ts,
    threadTs,
    isThreadReply: !!ts && !!threadTs && ts !== threadTs,
  }
}

// Fills only the arguments the caller left out, so an explicit `channel` or
// `ts` always wins over the link. `mapping` says what each argument means:
//   'channel' → the conversation ID
//   'ts'      → the linked message's own timestamp
//   'thread'  → the thread root (thread_ts when the link points at a reply)
// A leading '?' makes the argument optional: filled when the link carries it,
// silently skipped (not an error) when it does not.
export function applyLinkToArgs(args, mapping) {
  const { link, ...rest } = args || {}
  if (link === undefined) return { ok: true, args: rest }

  const parsed = parseSlackLink(link)
  if (!parsed.ok) return parsed

  const resolved = { ...rest }
  for (const [key, rawMeaning] of Object.entries(mapping)) {
    if (resolved[key] !== undefined) continue
    const optional = rawMeaning.startsWith('?')
    const meaning = optional ? rawMeaning.slice(1) : rawMeaning
    const value = meaning === 'channel' ? parsed.channel : meaning === 'ts' ? parsed.ts : parsed.threadTs
    if (value === undefined) {
      if (optional) continue
      return { ok: false, error: `link-has-no-${meaning === 'channel' ? 'channel' : 'message'}-for-${key}`, retryable: false }
    }
    resolved[key] = value
  }
  return { ok: true, args: resolved, link: parsed }
}
