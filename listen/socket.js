// Socket Mode listener (PLAN §4.2, step 6). Bolt (D8, 2026-09-09) — measured
// against a hand-rolled WebSocket client and chosen because Bolt already
// owns the envelope/ack semantics (redelivery on an unacked handler) and the
// retry behaviour a hand-rolled client would otherwise re-implement one bug
// at a time. This is the one dependency D7 asks a written reason for beyond
// node:sqlite; see PLAN.md's decisions table (D8) for the fuller argument.
//
// A LIBRARY first, a process second (D9) — `createListener` returns
// `{ start, stop }` and takes no ambient state (§0/D2: tokens and config are
// parameters). `cli/listen.js` is the thin process wrapper; the dashboard's
// supervisor, if it ends up owning this, calls `createListener` directly
// instead of spawning a second process.
//
// Emits classified events; never acts on them (§4.2's "emit, do not act" —
// §2.3/D3: inbound is a proposal, never an instruction that executes
// itself). `onClassified` is the caller's queue, not this module's job.

import { App } from '@slack/bolt'
import { classify } from '../core/classify.js'
import { recordAnswer, recordAnswerByThread } from '../core/ask.js'
import { publishHome } from '../core/home.js'
import { setOutputModeInConfig } from '../core/config-write.js'
import { maybeCreateAgentSessionForEvent } from '../core/agent-sessions.js'
import { startAgentSession, routeThreadReply, closeAgentSession, parseAgentSessionCommand, matchesMentionKeyword } from '../core/acp-sessions.js'
import { listBackendNames } from '../core/acp-backends.js'
import { reply } from '../core/post.js'

const SESSION_STOP_WORDS = new Set(['stop', 'exit'])

// Strips the leading "<@BOTID> " Slack always prepends to app_mention text,
// so keyword matching below sees only what the human actually typed.
export function stripMentionPrefix(text) {
  return (text || '').replace(/^\s*<@[A-Z0-9]+>\s*/, '')
}

// `dbPath` is optional — pass it to capture ask/approval answers
// (core/ask.js) as they arrive. Without it the listener still classifies
// events exactly as before; the ask feature is additive.
export function createListener({ env, botToken, appToken, config, configPath, dbPath, onClassified, onError }) {
  if (!botToken) throw new Error('botToken required')
  if (!appToken) throw new Error('appToken required — Socket Mode needs the app-level xapp- token alongside the bot token')

  const app = new App({ token: botToken, appToken, socketMode: true })

  const dispatch = async result => {
    try {
      if (dbPath) maybeCreateAgentSessionForEvent({ dbPath, config, classified: result })
      await onClassified(result)
    } catch (err) {
      if (onError) onError(err)
      else throw err
    }
  }

  app.event('app_mention', async ({ event }) => {
    // An @mention starting with the configured keyword is a session-start
    // trigger (PLAN: ACP thread sessions, Phase 2), not a new inbound
    // proposal to classify — same immediacy as the slash command, since
    // D24's allowlist (not classify()) is the actual trust boundary here.
    const stripped = stripMentionPrefix(event.text)
    const afterKeyword = dbPath && config.agentSessions?.enabled ? matchesMentionKeyword(stripped, config) : null
    if (afterKeyword !== null) {
      const { backendName, repoName, modelName, task } = parseAgentSessionCommand(afterKeyword)
      if (task) {
        await startAgentSession({
          env,
          config,
          dbPath,
          channel: event.channel,
          threadTs: event.thread_ts,
          backendName,
          repoName,
          modelName,
          task,
          requestedBy: event.user,
        })
        return
      }
    }

    await dispatch(
      classify(
        { type: 'app_mention', channel: event.channel, user: event.user, text: event.text, ts: event.ts, thread_ts: event.thread_ts },
        config
      )
    )
  })

  // message.im / message.channels / message.groups all land here; classify()
  // itself decides relevance from channel_type — see core/classify.js.
  app.message(async ({ message }) => {
    // A bot/app-authored message normally means noise (an edit, a join, a
    // notification from some other app), not a proposal — unless it's a DM
    // from an app explicitly trusted to act on a named human's behalf via
    // agentSessions.trustedApps ({ botOrAppId: slackUserId }), in which
    // case it's treated exactly like a DM from that human (same
    // allowlist/repo checks apply downstream, since requestedBy below
    // resolves to their real user id, not the app's).
    //
    // Detected via `bot_id`, not `subtype === 'bot_message'` — confirmed
    // live against a real message from a bot app (via conversations.history)
    // that carried `bot_id`/`app_id` with NO `subtype` field at all, which
    // would have skipped the trustedApps lookup entirely and fallen through
    // as an ordinary message. `bot_id` is the reliable signal either way.
    //
    // Scoped to channel_type === 'im' deliberately — without this, the same
    // trusted app posting a bot message into any CHANNEL thread would
    // resolve to the mapped human there too, letting it stop/reply-to/
    // rewind sessions across every channel it can post into, not just the
    // DM-trigger grant documented (found in review before publishing).
    const isBotOrSystemMessage = Boolean(message.subtype) || Boolean(message.bot_id)
    const trustedActingAs = message.bot_id && message.channel_type === 'im'
      ? config.agentSessions?.trustedApps?.[message.bot_id] || config.agentSessions?.trustedApps?.[message.app_id]
      : undefined
    if (isBotOrSystemMessage && !trustedActingAs) return
    // trustedActingAs must win over message.user when both are present —
    // a bot message from an app with its own associated bot USER (confirmed
    // live: `user` was populated with the bot's own U-id, not absent as
    // generic Slack docs suggest) would otherwise resolve requestedBy to
    // the bot's own identity instead of the human it's mapped to act as.
    const requestedBy = trustedActingAs || message.user

    // A free-text reply in a pending ask's thread is an answer, not a new
    // inbound proposal — capture it and stop, so it never also shows up as
    // a self-dm/dm-request event.
    if (dbPath && message.thread_ts) {
      const captured = recordAnswerByThread(dbPath, message.channel, message.thread_ts, {
        kind: 'question',
        text: message.text,
        user: requestedBy,
      })
      if (captured) return
    }

    // Typing "stop" or "exit" in an active (or restart-lost but still
    // persisted) session's thread ends it, instead of being forwarded to
    // the agent as a prompt — closeAgentSession works either way (in-memory
    // or DB-only), so this ends a session even if nobody ever resumed it.
    if (dbPath && message.thread_ts && SESSION_STOP_WORDS.has((message.text || '').trim().toLowerCase())) {
      const closed = await closeAgentSession({ dbPath, config, channel: message.channel, threadTs: message.thread_ts, requestedBy })
      if (closed.ok) {
        await reply({ token: botToken, channel: message.channel, threadTs: message.thread_ts, text: 'Session closed.' })
        return
      }
    }

    // A DM to the bot starting with the configured keyword is a session
    // trigger too — @mention doesn't apply in a DM (there's nothing to
    // @mention when you're already talking directly to the app), so this
    // is the DM equivalent of the app_mention keyword trigger above. No
    // channel needed at all: the session lives entirely in this DM thread.
    if (dbPath && message.channel_type === 'im' && config.agentSessions?.enabled) {
      const text = message.text || ''
      const afterKeyword = matchesMentionKeyword(text, config)
      if (afterKeyword !== null) {
        const { backendName, repoName, modelName, task } = parseAgentSessionCommand(afterKeyword)
        if (task) {
          await startAgentSession({
            env,
            config,
            dbPath,
            channel: message.channel,
            threadTs: message.thread_ts,
            backendName,
            repoName,
            modelName,
            task,
            requestedBy,
          })
          return
        }
      }
    }

    // A reply in a thread that has (or, after a listener restart, HAD) an
    // ACP agent session is a prompt into that session, not a new inbound
    // proposal — same "capture and stop" shape as the ask short-circuit
    // above, checked after it so a pending ask still wins if somehow both
    // exist on the same thread. routeThreadReply falls back to a resume
    // attempt (PLAN: ACP thread sessions, Phase 4) when there's no
    // in-memory session, and returns ok:false — same as "never had one" —
    // when nothing applies, so this always degrades to normal handling.
    if (dbPath && message.thread_ts) {
      const routed = await routeThreadReply({
        env,
        config,
        dbPath,
        channel: message.channel,
        threadTs: message.thread_ts,
        text: message.text,
        requestedBy,
      })
      if (routed.ok) return
    }

    await dispatch(
      classify(
        { type: 'message', channel_type: message.channel_type, channel: message.channel, user: message.user, text: message.text, ts: message.ts },
        config
      )
    )
  })

  // Approve/Deny button clicks (core/ask.js's `kind: 'approval'`). The
  // askId travels in the button's `value` as `${askId}:${label}` — this is
  // the ONLY way a button click is ever observable; Slack never delivers
  // it as a readable message, so there is no poll-based equivalent.
  app.action(/^ask_/, async ({ action, ack }) => {
    await ack()
    if (!dbPath) return
    const [askId, label] = String(action.value || '').split(':')
    if (askId) recordAnswer(dbPath, askId, { kind: 'approval', label })
  })

  app.command(config.slashCommands?.outputModeCommand || '/outputmode', async ({ command, ack, respond }) => {
    await ack()
    if (!config.slashCommands?.enabled) {
      await respond({ response_type: 'ephemeral', text: 'Slash commands are disabled for this bridge.' })
      return
    }
    const result = setOutputModeInConfig({ config, configPath, outputMode: (command.text || '').trim() })
    await respond({
      response_type: 'ephemeral',
      text: result.ok ? `Output mode set to ${result.outputMode}.` : 'Usage: /outputmode low|medium|high',
    })
  })

  // Starts an ACP agent session (PLAN: ACP thread sessions, D23/D24).
  // `/agent-session start [--backend name] [--repo name] [--model name] <task>` — the
  // resulting message's thread is the session; further replies in it are
  // routed by the `app.message` short-circuit above, not classify(). Gated
  // on config.agentSessions.enabled (feature toggle) AND D24's allowlist
  // (who specifically may start one) — never on channel membership alone.
  app.command('/agent-session', async ({ command, ack, respond }) => {
    await ack()
    if (!config.agentSessions?.enabled) {
      await respond({ response_type: 'ephemeral', text: 'Agent sessions are disabled for this bridge.' })
      return
    }
    const [subcommand, ...rest] = (command.text || '').trim().split(/\s+/)
    if (subcommand === 'close') {
      if (!command.thread_ts) {
        await respond({ response_type: 'ephemeral', text: 'Run /agent-session close from within the session\'s thread.' })
        return
      }
      const result = await closeAgentSession({ dbPath, config, channel: command.channel_id, threadTs: command.thread_ts, requestedBy: command.user_id })
      await respond({ response_type: 'ephemeral', text: result.ok ? 'Session closed.' : `Could not close: ${result.error}` })
      return
    }
    if (subcommand !== 'start') {
      await respond({ response_type: 'ephemeral', text: 'Usage: /agent-session start [--backend name] [--repo name] [--model name] <task> | /agent-session close' })
      return
    }
    const { backendName, repoName, modelName, task } = parseAgentSessionCommand(rest.join(' '))
    if (!task) {
      await respond({ response_type: 'ephemeral', text: 'A task description is required: /agent-session start <task>' })
      return
    }
    const result = await startAgentSession({
      env,
      config,
      dbPath,
      channel: command.channel_id,
      threadTs: command.thread_ts,
      backendName,
      repoName,
      modelName,
      task,
      requestedBy: command.user_id,
    })
    if (!result.ok) {
      await respond({ response_type: 'ephemeral', text: `Could not start agent session: ${result.error}` })
    }
  })

  // Message shortcut (PLAN: ACP thread sessions, Phase 2) — right-click a
  // message -> "Start agent session". Opens a modal for backend/repo/task;
  // actual session-start happens on submission (app.view below), gated the
  // same way as every other trigger (config.agentSessions.enabled + D24 —
  // the modal itself is not a trust boundary, startAgentSession's own
  // allowlist check is).
  app.shortcut('start_agent_session', async ({ shortcut, ack, client }) => {
    await ack()
    if (!config.agentSessions?.enabled) return
    const threadTs = shortcut.message?.thread_ts || shortcut.message_ts || shortcut.message?.ts
    await client.views.open({
      trigger_id: shortcut.trigger_id,
      view: {
        type: 'modal',
        callback_id: 'start_agent_session_modal',
        private_metadata: JSON.stringify({ channel: shortcut.channel?.id, threadTs }),
        title: { type: 'plain_text', text: 'Start agent session' },
        submit: { type: 'plain_text', text: 'Start' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'backend',
            label: { type: 'plain_text', text: 'Backend' },
            element: {
              type: 'static_select',
              action_id: 'value',
              initial_option: { text: { type: 'plain_text', text: 'claude' }, value: 'claude' },
              options: listBackendNames().map(name => ({ text: { type: 'plain_text', text: name }, value: name })),
            },
          },
          {
            type: 'input',
            block_id: 'repo',
            optional: true,
            label: { type: 'plain_text', text: 'Repo (blank = default)' },
            element: { type: 'plain_text_input', action_id: 'value' },
          },
          {
            type: 'input',
            block_id: 'model',
            optional: true,
            label: { type: 'plain_text', text: 'Model (blank = backend default)' },
            element: { type: 'plain_text_input', action_id: 'value' },
          },
          {
            type: 'input',
            block_id: 'task',
            label: { type: 'plain_text', text: 'Task' },
            element: { type: 'plain_text_input', action_id: 'value', multiline: true },
          },
        ],
      },
    })
  })

  app.view('start_agent_session_modal', async ({ view, ack, body }) => {
    await ack()
    const { channel, threadTs } = JSON.parse(view.private_metadata || '{}')
    const values = view.state.values
    const backendName = values.backend?.value?.selected_option?.value
    const repoName = values.repo?.value?.value || undefined
    const modelName = values.model?.value?.value || undefined
    const task = values.task?.value?.value
    if (!channel || !threadTs || !task) return
    await startAgentSession({ env, config, dbPath, channel, threadTs, backendName, repoName, modelName, task, requestedBy: body.user.id })
  })

  // Republishes the feature-guide Home tab whenever someone opens it —
  // requires features.app_home.home_tab_enabled in the manifest, otherwise
  // this is a no-op failure that onError sees but nothing else depends on.
  app.event('app_home_opened', async ({ event }) => {
    const result = await publishHome({ token: botToken, userId: event.user })
    if (!result.ok && onError) onError(new Error(`publishHome failed: ${result.error}`))
  })

  app.error(err => {
    if (onError) onError(err)
  })

  return {
    start: () => app.start(),
    stop: () => app.stop(),
  }
}
