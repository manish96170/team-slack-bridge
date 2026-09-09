// Classification, pure and testable (PLAN §4.2/§2.3/§2.4). A pure function
// of (event, config) — no Slack connection, no side effects — so the two
// self-DM gates and the whole-word trigger match are covered by a table of
// cases (test/classify.test.js) with no listener involved.
//
// This produces a PROPOSAL, never an instruction that executes itself
// (§2.3/D3): the caller decides what to do with `kind`, this function only
// names it.

export const START_NOW_TRIGGERS = ['start right now', 'start right away', 'srn', 'sra']

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Whole-word only: "sra" must not fire from inside "extras". \b requires a
// word/non-word transition on both sides, so a trigger embedded in a longer
// word never matches.
function hasStartNowTrigger(text) {
  if (!text) return false
  const normalized = text.toLowerCase()
  return START_NOW_TRIGGERS.some(trigger => new RegExp(`\\b${escapeRegExp(trigger)}\\b`).test(normalized))
}

function findWatchedChannel(config, channelId) {
  return (config?.watchedChannels || []).find(entry => entry.channel === channelId)
}

// D13 (2026-09-09): the DM-reading gate is sender identity + channel type
// (Slack-asserted, unspoofable — a password over a pull path never runs on
// this push-delivered event, §2.7), PLUS an explicit allow-list of
// additional user IDs for anyone besides the owner permitted to DM the
// bridge at all. Allow-listed non-owner DMs are never self-dm-shaped —
// the dashboard's own rule (§2.4 gate 1) ties the self-DM exception
// specifically to the owner's own DM, and that isn't renegotiated here.
// They classify as `dm-request` — a plain proposal, full pending flow,
// trigger words ignored regardless of wording (§2.4's closing sentence).
function isAllowlisted(config, userId) {
  return (config?.dmAllowlist || []).includes(userId)
}

export function classify(event, config = {}) {
  if (!event || !event.type) return { kind: 'ignore', reason: 'no-event' }

  if (event.type === 'message' && event.channel_type === 'im') {
    const ownerId = config?.owner?.slackUserId
    if (ownerId && event.user === ownerId) {
      if (hasStartNowTrigger(event.text)) return { kind: 'self-dm-start-now', event }
      return { kind: 'self-dm', event }
    }
    if (isAllowlisted(config, event.user)) return { kind: 'dm-request', event }
    return { kind: 'ignore', reason: 'dm-not-owner-or-allowed' }
  }

  if (event.type === 'app_mention') {
    const watched = findWatchedChannel(config, event.channel)
    if (!watched) return { kind: 'ignore', reason: 'unwatched-channel' }
    const kind = watched.purpose === 'review-request' ? 'review-request' : 'team-request'
    return { kind, event, channel: watched.channel }
  }

  return { kind: 'ignore', reason: 'unhandled-event-type' }
}
