// The hub (PLAN D74): the one place that decides whether someone may run a
// session on an owner's machine, and what that session may do once running.
//
// It never runs an agent itself. It checks policy, asks the owner when policy
// has no answer, and then hands an approved request to a host (see
// transport.js). Everything it needs from outside arrives as a parameter, so
// the same code runs embedded in a listener today and as a network hub later.
//
// Trust boundary: the owner is whoever Slack says sent the event, compared to
// the configured owner id. Text an agent produces is never parsed here: only
// inbound Slack events reach handleOwnerMessage/handleAction.

import { randomUUID } from 'node:crypto'
import { getDb } from '../db.js'
import { postToChannel } from '../post.js'
import { callSlack } from '../slack.js'
import { resolveDmChannel } from '../dm.js'
import { lookupUser } from '../directory.js'
import { listAgentSessions } from '../agent-sessions.js'
import { listRepos, resolveRepoPath } from '../repos.js'
import { parseOwnerCommand, parseApprovalReply } from './commands.js'

const APPROVAL_GRANT_TTL_MS = 60_000
const MAX_PENDING_PER_REQUESTER = 2
const MAX_PENDING_TOTAL = 10
const DENY_COOLDOWN_MS = 5 * 60_000
const TASK_PREVIEW_CHARS = 300
const LIVE_STATUSES = ['approved', 'approved_once']

function clip(text, max) {
  const value = String(text || '')
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function slackEscape(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function quote(text) {
  return slackEscape(clip(text, TASK_PREVIEW_CHARS))
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n')
}

function button(label, actionId, value, style) {
  return { type: 'button', text: { type: 'plain_text', text: label, emoji: true }, action_id: actionId, value, ...(style ? { style } : {}) }
}

export function createHub({ env, config, dbPath, store, hosts, ownerId, now = () => Date.now(), setTimer = setTimeout }) {
  if (!ownerId) throw new Error('hub requires a configured owner')
  const token = env.SLACK_BOT_TOKEN
  const hubConfig = config.hub
  const approvals = new Map()

  const db = () => getDb(dbPath)

  function getRequest(id) {
    return id ? db().prepare('SELECT * FROM hub_requests WHERE id = ?').get(id) || null : null
  }

  function getRequestByCard(channel, ts) {
    return db().prepare('SELECT * FROM hub_requests WHERE card_channel = ? AND card_ts = ?').get(channel, ts) || null
  }

  function setStatus(id, status, extra = {}) {
    db()
      .prepare('UPDATE hub_requests SET status = ?, level = COALESCE(?, level), decided_at = ? WHERE id = ?')
      .run(status, extra.level || null, new Date(now()).toISOString(), id)
  }

  function say({ channel, threadTs, text, blocks }) {
    return postToChannel({ token, channel, text, blocks, threadTs, config })
  }

  async function dmOwner({ text, blocks }) {
    const opened = await resolveDmChannel({ token, userId: ownerId, dbPath })
    if (!opened.ok) return opened
    const posted = await postToChannel({ token, channel: opened.channel.id, text, blocks, config })
    return posted.ok ? { ...posted, channel: opened.channel.id } : posted
  }

  function cardContent(row, { stopped = false } = {}) {
    const who = `<@${row.requester_id}>`
    const head = `${who} · repo \`${row.repo}\``
    const task = quote(row.task)
    if (row.status === 'pending') {
      return {
        text: `${who} wants to start a session on your machine (repo ${row.repo})`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `:key: ${who} wants to start a session on *your machine*\nRepo: \`${row.repo}\`\n${task}` } },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text:
                'Use the buttons, or reply in this thread with the repos to approve (comma separated, e.g. `api, web`), `all` for just the one above, or `no`. Add `level=ask` to approve each step yourself, or `level=readonly`.',
            },
          },
          {
            type: 'actions',
            block_id: `hub:${row.id}`,
            elements: [
              button('Allow always', 'hub_decision_always', `${row.id}:always`, 'primary'),
              button('Allow once', 'hub_decision_once', `${row.id}:once`),
              button('Deny', 'hub_decision_deny', `${row.id}:deny`, 'danger'),
            ],
          },
        ],
      }
    }
    if (LIVE_STATUSES.includes(row.status)) {
      const kind = row.status === 'approved' ? 'always' : 'this session only'
      const state = stopped ? ':octagonal_sign: stopped' : ':white_check_mark: running'
      return {
        text: `Session ${stopped ? 'stopped' : 'running'} for ${who} (${row.repo})`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `${state} · ${head} · approved (${kind})\n${task}` } },
          {
            type: 'actions',
            block_id: `hubctl:${row.id}`,
            elements: [
              button('Stop', 'hub_ctl_stop', `${row.id}:stop`, 'danger'),
              button('Restart', 'hub_ctl_restart', `${row.id}:restart`),
              button('Block user', 'hub_ctl_block', `${row.id}:block`, 'danger'),
            ],
          },
          { type: 'context', elements: [{ type: 'mrkdwn', text: 'Or reply in this thread: `stop`, `restart`, `block`.' }] },
        ],
      }
    }
    const label = { denied: 'denied', expired: 'expired without an answer', failed: 'failed to start' }[row.status] || row.status
    return {
      text: `Request from ${who} ${label}`,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:no_entry_sign: ${head} · ${label}\n${task}` } }],
    }
  }

  async function postCard(row) {
    const { text, blocks } = cardContent(row)
    const posted = await dmOwner({ text, blocks })
    if (posted.ok) db().prepare('UPDATE hub_requests SET card_channel = ?, card_ts = ? WHERE id = ?').run(posted.channel, posted.ts, row.id)
    return posted
  }

  async function refreshCard(id) {
    const row = getRequest(id)
    if (!row?.card_channel || !row.card_ts) return
    const sessions = sessionRowsFor(id)
    const stopped = sessions.length > 0 && sessions.every(session => session.status === 'closed')
    const { text, blocks } = cardContent(row, { stopped })
    await callSlack('chat.update', token, { channel: row.card_channel, ts: row.card_ts, text, blocks })
  }

  function sessionRowsFor(requestId) {
    return listAgentSessions({ dbPath, kind: 'acp-session', limit: 1000 }).filter(session => session.metadata?.hubRequestId === requestId)
  }

  async function notifyRequester(row, text) {
    return say({ channel: row.channel, threadTs: row.thread_ts || undefined, text })
  }

  async function launch(row, level) {
    const host = hosts.get(row.target_id)
    if (!host || !host.isOnline()) {
      setStatus(row.id, 'failed')
      await refreshCard(row.id)
      await notifyRequester(row, `<@${row.target_id}>'s machine is offline, so nothing was started.`)
      return { ok: false, error: 'host-offline' }
    }
    const approvalToken = randomUUID()
    approvals.set(approvalToken, { requesterId: row.requester_id, repo: row.repo, requestId: row.id, expiresAt: now() + APPROVAL_GRANT_TTL_MS })

    const fresh = getRequest(row.id)
    if (fresh.card_ts) await refreshCard(row.id)
    else await postCard(fresh)

    void (async () => {
      try {
        const result = await host.startSession({
          channel: row.channel,
          threadTs: row.thread_ts || undefined,
          backendName: row.backend || undefined,
          repoName: row.repo,
          modelName: row.model || undefined,
          task: row.task,
          requestedBy: row.requester_id,
          delegation: { token: approvalToken, ownerId, requestId: row.id, level },
        })
        if (!result?.ok) {
          setStatus(row.id, 'failed')
          await refreshCard(row.id)
          await notifyRequester(row, `Could not start the session: ${result?.error || 'unknown error'}`)
        }
      } catch (err) {
        setStatus(row.id, 'failed')
        await refreshCard(row.id)
        await notifyRequester(row, `Could not start the session: ${err.message || err}`)
      }
    })()
    return { ok: true }
  }

  async function expire(id) {
    const row = getRequest(id)
    if (!row || row.status !== 'pending') return
    setStatus(id, 'expired')
    await refreshCard(id)
    await notifyRequester(row, `<@${row.target_id}> did not answer in time, so nothing was started. Ask again when they are around.`)
  }

  // The pending -> decided transition is one conditional UPDATE, so a duplicate
  // Slack delivery, or a button click racing a thread reply, can only win once.
  function claimDecision(id, status) {
    const result = db()
      .prepare("UPDATE hub_requests SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending' AND expires_at > ?")
      .run(status, new Date(now()).toISOString(), id, new Date(now()).toISOString())
    return result.changes === 1
  }

  async function decide(row, { decision, repos, level, by }) {
    if (row.status !== 'pending') return { ok: false, error: 'already-handled' }
    if (Date.parse(row.expires_at) <= now()) {
      await expire(row.id)
      return { ok: false, error: 'expired' }
    }
    if (!claimDecision(row.id, 'deciding')) return { ok: false, error: 'already-handled' }
    const chosenLevel = level || hubConfig.defaultGrantLevel

    if (decision === 'deny') {
      setStatus(row.id, 'denied')
      await refreshCard(row.id)
      await notifyRequester(row, `<@${row.target_id}> declined, so nothing was started.`)
      return { ok: true, decision }
    }

    if (decision === 'once') {
      setStatus(row.id, 'approved_once', { level: chosenLevel })
      await launch(getRequest(row.id), chosenLevel)
      return { ok: true, decision, level: chosenLevel }
    }

    const toGrant = repos?.length ? repos : [row.repo]
    const granted = store.grant({ userId: row.requester_id, repos: toGrant, level: chosenLevel, by })
    if (!granted.ok) {
      db().prepare("UPDATE hub_requests SET status = 'pending', decided_at = NULL WHERE id = ?").run(row.id)
      return granted
    }
    if (!toGrant.includes(row.repo)) {
      setStatus(row.id, 'denied')
      await refreshCard(row.id)
      await notifyRequester(row, `<@${row.target_id}> approved other repos but not \`${row.repo}\`, so nothing was started.`)
      return { ok: true, decision: 'grant-other', repos: toGrant }
    }
    setStatus(row.id, 'approved', { level: chosenLevel })
    await launch(getRequest(row.id), chosenLevel)
    return { ok: true, decision: 'grant', repos: toGrant, level: chosenLevel }
  }

  async function stopRequest(row) {
    const sessions = sessionRowsFor(row.id).filter(session => session.status !== 'closed')
    for (const session of sessions) await hosts.get(row.target_id)?.stopSession({ id: session.id })
    await refreshCard(row.id)
    await notifyRequester(row, `<@${row.target_id}> stopped this session. Messages here are ignored until they restart it.`)
    return { ok: true, stopped: sessions.length }
  }

  async function restartRequest(row) {
    const sessions = sessionRowsFor(row.id).filter(session => session.status === 'closed')
    if (!sessions.length) return { ok: false, error: 'nothing-to-restart' }
    if (!LIVE_STATUSES.includes(row.status)) return { ok: false, error: 'request-not-active' }
    if (store.isBlocked(row.requester_id)) return { ok: false, error: 'blocked' }
    if (row.status === 'approved') {
      const access = store.checkAccess({ userId: row.requester_id, repo: row.repo })
      if (!access.ok) return { ok: false, error: access.reason }
    }
    for (const session of sessions) await hosts.get(row.target_id)?.restartSession({ id: session.id })
    await refreshCard(row.id)
    await notifyRequester(row, `<@${row.target_id}> restarted this session. You can continue replying here.`)
    return { ok: true, restarted: sessions.length }
  }

  async function blockUser(userId, by) {
    const blocked = store.block({ userId, by })
    if (!blocked.ok) return blocked
    const stopped = (await hosts.get(ownerId)?.stopAllFor(userId)) || []
    db()
      .prepare("UPDATE hub_requests SET status = 'denied', decided_at = ? WHERE requester_id = ? AND status IN ('pending', 'approved', 'approved_once')")
      .run(new Date(now()).toISOString(), userId)
    for (const item of stopped) {
      await say({ channel: item.channel, threadTs: item.threadTs, text: `<@${ownerId}> removed your access, so this session was stopped.` })
    }
    return { ok: true, stopped: stopped.length }
  }

  function knownRepoNames() {
    return Object.keys(listRepos().repos)
  }

  function formatGrants() {
    const listed = store.list()
    if (!listed.ok) return `Hub policy unavailable (${listed.error}). Nothing is delegated until it is fixed.`
    const { grants, blocked } = listed.policy
    const lines = []
    for (const [userId, repos] of Object.entries(grants)) {
      const items = Object.entries(repos).map(([repo, grant]) => `\`${repo}\` (${grant.level}${grant.expiresAt ? `, until ${grant.expiresAt}` : ''})`)
      lines.push(`• <@${userId}>: ${items.join(', ')}`)
    }
    for (const userId of Object.keys(blocked)) lines.push(`• <@${userId}>: *blocked*`)
    return lines.length ? `*Delegation grants*\n${lines.join('\n')}` : 'No grants and no blocked users.'
  }

  async function runOwnerCommand(command) {
    if (command.error) return `Usage: ${command.usage}`
    if (command.name === 'grants') return formatGrants()
    if (command.name === 'block') {
      const result = await blockUser(command.userId, ownerId)
      return result.ok ? `<@${command.userId}> is blocked and ${result.stopped} running session(s) were stopped.` : `Could not block: ${result.error}`
    }
    if (command.name === 'unblock') {
      const result = store.unblock({ userId: command.userId, by: ownerId })
      return result.ok ? `<@${command.userId}> is unblocked. They have no grants until you approve a request again.` : `Could not unblock: ${result.error}`
    }
    if (command.name === 'revoke') {
      const result = store.revoke({ userId: command.userId, repos: command.repos, by: ownerId })
      if (!result.ok) return `Could not revoke: ${result.error}`
      if (!result.revoked.length) return 'Nothing to revoke.'
      const stopped = (await hosts.get(ownerId)?.stopAllFor(command.userId, result.revoked)) || []
      for (const item of stopped) await say({ channel: item.channel, threadTs: item.threadTs, text: `<@${ownerId}> removed your access to this repo, so this session was stopped.` })
      return `Revoked ${result.revoked.map(repo => `\`${repo}\``).join(', ')} for <@${command.userId}> and stopped ${stopped.length} running session(s).`
    }
    if (command.name === 'grant') {
      const known = knownRepoNames()
      const unknown = command.repos.filter(repo => !known.includes(repo))
      if (unknown.length) return `Unknown repo(s): ${unknown.join(', ')}. Registered: ${known.join(', ') || '(none)'}.`
      const result = store.grant({ userId: command.userId, repos: command.repos, level: command.level || hubConfig.defaultGrantLevel, expires: command.expires, by: ownerId })
      return result.ok
        ? `Granted <@${command.userId}> ${result.granted.map(repo => `\`${repo}\``).join(', ')} at level \`${result.level}\`${result.expiresAt ? ` until ${result.expiresAt}` : ''}.`
        : `Could not grant: ${result.error}`
    }
    return 'Unknown command.'
  }

  const hub = {
    ownerId,
    store,
    hosts,

    isBlocked: userId => store.isBlocked(userId),

    // 'always' | 'ask' | 'readonly', or 'blocked'. Read live on every
    // permission request, so an owner's change takes effect mid-session.
    levelFor({ requestId, userId, repo }) {
      if (store.isBlocked(userId)) return 'blocked'
      const row = getRequest(requestId)
      if (row) {
        if (row.requester_id !== userId) return 'blocked'
        if (!LIVE_STATUSES.includes(row.status)) return 'blocked'
        if (row.status === 'approved_once') return row.level || hubConfig.defaultGrantLevel
      }
      const access = store.checkAccess({ userId, repo })
      return access.ok ? access.level : 'blocked'
    },

    canPrompt({ requestId, userId, startedBy, repo }) {
      if (startedBy && userId !== startedBy) return { ok: false, reason: 'not-the-requester' }
      const level = hub.levelFor({ requestId, userId, repo })
      return level === 'blocked' ? { ok: false, reason: 'access-removed' } : { ok: true, level }
    },

    // One-time proof that THIS hub approved THIS request; startAgentSession
    // refuses a delegated start without it, so no other caller can claim one.
    consumeApproval(approvalToken, { requesterId, repo }) {
      const approval = approvals.get(approvalToken)
      approvals.delete(approvalToken)
      if (!approval || approval.expiresAt <= now()) return null
      if (approval.requesterId !== requesterId || approval.repo !== repo) return null
      return { requestId: approval.requestId }
    },

    async resolveTarget(target) {
      if (target.userId) return { ok: true, userId: target.userId }
      const found = await lookupUser({ query: target.name, mode: 'name', token, ttlMs: config.directoryLookup?.cacheTtlMs })
      if (found.ok) return { ok: true, userId: found.user.id, name: found.user.displayName }
      return found
    },

    async noticeIfTampered() {
      const reason = store.consumeTamperNotice()
      if (reason) {
        await dmOwner({
          text: `:warning: The hub policy file failed its integrity check (${reason}). Delegated sessions are refused until you review it and run \`tsb-hub resign\`.`,
        })
      }
    },

    async handleStartRequest({ requesterId, channel, threadTs, targetUserId, repoName, backendName, modelName, task }) {
      await hub.noticeIfTampered()
      const reply = text => say({ channel, threadTs, text })

      if (targetUserId !== ownerId && !hosts.get(targetUserId)) {
        await reply(`<@${targetUserId}>'s machine is not connected to this hub, so nothing was started.`)
        return { ok: false, error: 'host-not-connected' }
      }
      const host = hosts.get(targetUserId)
      if (!host || !host.isOnline()) {
        await reply(`<@${targetUserId}>'s machine is offline, so nothing was started.`)
        return { ok: false, error: 'host-offline' }
      }

      const policyAccess = store.checkAccess({ userId: requesterId, repo: '*' })
      if (policyAccess.reason === 'blocked' || policyAccess.reason === 'policy-tampered' || policyAccess.reason === 'policy-unreadable' || policyAccess.reason === 'policy-owner-mismatch') {
        await reply(policyAccess.reason === 'blocked' ? `You are not allowed to start sessions on <@${targetUserId}>'s machine.` : 'Delegation is paused on that machine until its owner reviews the hub policy.')
        return { ok: false, error: policyAccess.reason }
      }

      const repo = resolveRepoPath(repoName)
      if (!repo.ok) {
        await reply(repo.error === 'no-repo-specified-and-no-default' ? 'Say which repo with `--repo <name>`; that machine has no default repo.' : `That machine has no repo called \`${repoName}\`.`)
        return { ok: false, error: repo.error }
      }

      const access = store.checkAccess({ userId: requesterId, repo: repo.name })
      const base = {
        id: randomUUID(),
        requester_id: requesterId,
        target_id: targetUserId,
        repo: repo.name,
        backend: backendName || null,
        model: modelName || null,
        task,
        channel,
        thread_ts: threadTs || null,
      }
      const createdAt = new Date(now()).toISOString()
      const insert = (status, level) => {
        db()
          .prepare(
            `INSERT INTO hub_requests (id, requester_id, target_id, repo, backend, model, task, channel, thread_ts, status, level, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            base.id,
            base.requester_id,
            base.target_id,
            base.repo,
            base.backend,
            base.model,
            base.task,
            base.channel,
            base.thread_ts,
            status,
            level || null,
            createdAt,
            new Date(now() + hubConfig.approvalTimeoutSeconds * 1000).toISOString()
          )
      }

      if (access.ok) {
        insert('approved', access.level)
        await launch(getRequest(base.id), access.level)
        return { ok: true, requestId: base.id, approved: 'existing-grant' }
      }

      const pendingForRequester = db().prepare("SELECT COUNT(*) AS n FROM hub_requests WHERE requester_id = ? AND status = 'pending'").get(requesterId).n
      const pendingTotal = db().prepare("SELECT COUNT(*) AS n FROM hub_requests WHERE status = 'pending'").get().n
      if (pendingForRequester >= MAX_PENDING_PER_REQUESTER || pendingTotal >= MAX_PENDING_TOTAL) {
        await reply('There are already pending requests waiting for an answer. Wait for them to be answered first.')
        return { ok: false, error: 'too-many-pending' }
      }
      const recentDeny = db()
        .prepare("SELECT decided_at FROM hub_requests WHERE requester_id = ? AND status = 'denied' ORDER BY decided_at DESC LIMIT 1")
        .get(requesterId)
      if (recentDeny && now() - Date.parse(recentDeny.decided_at) < DENY_COOLDOWN_MS) {
        await reply(`<@${targetUserId}> declined recently. Try again in a few minutes.`)
        return { ok: false, error: 'recently-denied' }
      }

      insert('pending')
      const row = getRequest(base.id)
      const card = await postCard(row)
      if (!card.ok) {
        setStatus(row.id, 'failed')
        await reply(`Could not reach <@${targetUserId}> to ask for approval (${card.error}).`)
        return { ok: false, error: 'approval-card-failed' }
      }
      await reply(`Asked <@${targetUserId}> to approve a session on \`${repo.name}\`. I'll start it as soon as they answer.`)
      const timer = setTimer(() => void expire(row.id), hubConfig.approvalTimeoutSeconds * 1000)
      timer?.unref?.()
      return { ok: true, requestId: row.id, pending: true }
    },

    // Owner-only text. Returns { handled } so the caller can fall through to
    // ordinary message handling for anything that is not a hub message.
    async handleOwnerMessage({ userId, text, channel, threadTs }) {
      if (userId !== ownerId) return { handled: false }
      const row = threadTs ? getRequestByCard(channel, threadTs) : null

      if (row?.status === 'pending') {
        const parsed = parseApprovalReply(text, { requestedRepo: row.repo, knownRepos: knownRepoNames() })
        if (!parsed.ok) {
          const detail =
            parsed.error === 'unknown-repos' ? `Unknown repo(s): ${parsed.unknown.join(', ')}. Registered: ${parsed.knownRepos.join(', ') || '(none)'}.` : 'Reply with repo names (comma separated), `all`, or `no`.'
          await say({ channel, threadTs, text: detail })
          return { handled: true }
        }
        const result = await decide(row, { decision: parsed.decision === 'deny' ? 'deny' : 'grant', repos: parsed.repos, level: parsed.level, by: ownerId })
        if (!result.ok) await say({ channel, threadTs, text: `Could not apply that: ${result.error}` })
        return { handled: true }
      }

      if (row) {
        const command = (text || '').trim().toLowerCase()
        if (command === 'stop' || command === 'restart' || command === 'block') {
          const result = command === 'stop' ? await stopRequest(row) : command === 'restart' ? await restartRequest(row) : await blockUser(row.requester_id, ownerId)
          if (!result.ok) await say({ channel, threadTs, text: `Could not ${command}: ${result.error}` })
          else if (command === 'block') await say({ channel, threadTs, text: `<@${row.requester_id}> is blocked.` })
          return { handled: true }
        }
      }

      // Outside a card thread a command must start with `hub`, so an ordinary
      // DM that merely begins with "block" or "grant" is never hijacked.
      const prefixed = /^\s*hub\s+([\s\S]+)$/i.exec(text || '')
      if (!prefixed) return { handled: false }
      const command = parseOwnerCommand(prefixed[1])
      if (!command || command.name === 'stop' || command.name === 'restart') {
        await say({ channel, threadTs, text: 'Hub commands: `hub grants`, `hub grant @user repo=a,b [level=always|ask|readonly] [expires=7d]`, `hub revoke @user [repo=a,b]`, `hub block @user`, `hub unblock @user`.' })
        return { handled: true }
      }
      await say({ channel, threadTs, text: await runOwnerCommand(command) })
      return { handled: true }
    },

    async handleAction({ userId, value }) {
      if (userId !== ownerId) return { ok: false, error: 'not-owner' }
      const [requestId, what] = String(value || '').split(':')
      const row = getRequest(requestId)
      if (!row) return { ok: false, error: 'request-not-found' }
      if (['always', 'once', 'deny'].includes(what)) return decide(row, { decision: what === 'always' ? 'grant' : what, by: ownerId })
      if (what === 'stop') return stopRequest(row)
      if (what === 'restart') return restartRequest(row)
      if (what === 'block') {
        const result = await blockUser(row.requester_id, ownerId)
        if (result.ok) await refreshCard(row.id)
        return result
      }
      return { ok: false, error: 'unknown-action' }
    },
  }
  return hub
}
