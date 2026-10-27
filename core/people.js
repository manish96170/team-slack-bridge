// Plain-English cross-company messaging (ROADMAP.md "Plain-English
// cross-company messaging", PLAN D64). This is wiring, not new state —
// one combined resolve-and-send primitive over three already-built
// pieces: core/accounts.js's name->home registry (D21) resolves a
// human-chosen company alias to an account home, core/directory.js's
// lookupUser does a live Slack-directory lookup for the person inside
// that account, and core/dm.js's dm() sends with that account's own
// resolved token. One combined result instead of two disjoint calls
// means an account/person mismatch between lookup and send is
// structurally impossible — both go through the exact same resolved
// account context.
//
// No ambient state: everything this function needs comes back from
// resolveAccountHome/loadAccountContext as explicit values, never a
// bare process.env read here (PLAN D2's rule, applied the same way
// every other core/*.js file already does).

import { resolveAccountHome, loadAccountContext } from './accounts.js'
import { lookupUser } from './directory.js'
import { dm } from './dm.js'

export async function dmByName({ accountName, personName, text, asUser, dryRun } = {}) {
  if (!personName || !personName.trim()) return { ok: false, error: 'person-name-required', retryable: false }
  if (!text) return { ok: false, error: 'text-required', retryable: false }

  const resolvedAccount = resolveAccountHome(accountName)
  if (!resolvedAccount.ok) {
    // accountName was never given (nothing to resolve against but
    // whatever the registry calls "the default") AND resolution still
    // failed — a materially different situation from "a specific name
    // was given and it's wrong" (account-not-found, propagated below
    // unchanged for that case). This is the one refusal ROADMAP.md
    // requires a distinct, specific code for: never guess which
    // company, let the skill layer ask instead.
    if (!accountName) return { ok: false, error: 'no-company-specified-and-no-default-configured', retryable: false }
    return resolvedAccount
  }

  const context = loadAccountContext(resolvedAccount.name)
  if (!context.ok) return context
  const { env, config, dbPath } = context

  // Live-first (PLAN D64's answer to ROADMAP.md's open question): go
  // straight to the live directory lookup rather than trying
  // slack-config.json's resolveUser first. A config-file-first attempt
  // would only ever save one Slack round trip for someone already
  // hand-entered into that account's config, and would need its own
  // ambiguous-match/not-found handling duplicated from
  // core/directory.js — for a feature whose whole point is reaching
  // people who are NOT already in that list, "always complete" beat
  // "sometimes faster."
  const person = await lookupUser({
    query: personName,
    token: env.SLACK_BOT_TOKEN,
    tokenSource: 'bot',
    ttlMs: config?.directoryLookup?.cacheTtlMs,
  })
  if (!person.ok) return person

  const sendResult = await dm({
    botToken: env.SLACK_BOT_TOKEN,
    userToken: env.SLACK_USER_TOKEN,
    userId: person.user.id,
    text,
    asUser,
    config,
    dbPath,
    dryRun,
  })

  return {
    ok: sendResult.ok,
    ...(sendResult.ok ? {} : { error: sendResult.error, retryable: sendResult.retryable }),
    account: resolvedAccount.name,
    person: person.user,
    send: sendResult,
  }
}
