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

// `dbPath` is optional — pass it to capture ask/approval answers
// (core/ask.js) as they arrive. Without it the listener still classifies
// events exactly as before; the ask feature is additive.
export function createListener({ botToken, appToken, config, configPath, dbPath, onClassified, onError }) {
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
    if (message.subtype) return // edits, joins, etc. — not a proposal

    // A free-text reply in a pending ask's thread is an answer, not a new
    // inbound proposal — capture it and stop, so it never also shows up as
    // a self-dm/dm-request event.
    if (dbPath && message.thread_ts) {
      const captured = recordAnswerByThread(dbPath, message.channel, message.thread_ts, {
        kind: 'question',
        text: message.text,
        user: message.user,
      })
      if (captured) return
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
