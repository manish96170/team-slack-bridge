// User-group lookup (D72). Slack user groups (@reviewers, @oncall) mention as
// <!subteam^S0123ABC>, which needs the group ID — not something a caller can
// guess from the handle. Read-only: usergroups.list (+ usergroups.users.list
// when members are asked for). Needs usergroups:read; either token works, so
// like slack_lookup_user the token source is explicit and echoed back.

import { callSlack } from './slack.js'

const MAX_RESULTS = 100
const MAX_MEMBER_EXPANSIONS = 5

function normalize(value) {
  return (value || '').trim().replace(/^[@!]/, '').toLowerCase()
}

function shape(group) {
  return {
    id: group.id,
    handle: group.handle,
    name: group.name,
    description: group.description || undefined,
    userCount: group.user_count,
    disabled: !!group.date_delete,
    mention: `<!subteam^${group.id}>`,
  }
}

export async function lookupUserGroup({ token, tokenSource, query, includeMembers = false, includeDisabled = false, slackCall = callSlack }) {
  if (!token) return { ok: false, error: 'no-token', retryable: false }
  const listed = await slackCall('usergroups.list', token, {
    include_count: 'true',
    include_disabled: includeDisabled ? 'true' : 'false',
  })
  if (!listed.ok) return listed

  const groups = (listed.usergroups || []).map(shape)
  const needle = normalize(query)
  let matches = groups
  let exact = false
  if (needle) {
    const exactMatches = groups.filter(group => [normalize(group.handle), normalize(group.name), group.id.toLowerCase()].includes(needle))
    if (exactMatches.length > 1) {
      return { ok: false, error: 'ambiguous-usergroup', retryable: false, tokenSource, matches: exactMatches }
    }
    exact = exactMatches.length === 1
    matches = exact
      ? exactMatches
      : groups.filter(group => normalize(group.handle).includes(needle) || normalize(group.name).includes(needle))
    if (!matches.length) return { ok: false, error: 'usergroup-not-found', retryable: false, tokenSource }
  }

  const truncated = matches.length > MAX_RESULTS
  matches = matches.slice(0, MAX_RESULTS)

  if (includeMembers) {
    if (matches.length > MAX_MEMBER_EXPANSIONS) {
      return { ok: false, error: 'too-many-groups-to-expand-members-narrow-the-query', retryable: false, tokenSource, count: matches.length }
    }
    matches = await Promise.all(matches.map(async group => {
      const members = await slackCall('usergroups.users.list', token, { usergroup: group.id })
      return members.ok ? { ...group, members: members.users || [] } : { ...group, membersError: members.error }
    }))
  }

  return { ok: true, tokenSource, exact, truncated, usergroups: matches }
}
