// Persistent ACP connections, one per backend, multiplexing many sessions
// via session/new rather than one process per Slack thread (per the
// research: ACP is designed for this). Built on the official
// @agentclientprotocol/sdk (PLAN: hand-rolling the full fs/terminal/
// permission/session-lifecycle surface here would be a materially bigger
// protocol-compliance risk than the small MCP surfaces this repo hand-rolls
// elsewhere — this is the "argued in writing" case for a new dependency,
// D7).
//
// session/update streaming for a `buildSession()`-created session is owned
// by the SDK's own `ActiveSession.nextUpdate()` internally — this module
// only answers the agent's own REQUESTS (permission, fs, terminal),
// dispatched by sessionId to whichever session registered a handler via
// `registerSession`. The one exception: a global `session/update`
// notification tap IS registered below, for resumed/loaded sessions only
// (PLAN: ACP thread sessions, Phase 4) — verified from the SDK's own source
// (SessionUpdateRouter.handleMessage always returns Handled.no(), i.e. it
// taps without consuming, so this coexists safely with ActiveSession's own
// internal routing for every other session).

import { spawn } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import { client, ndJsonStream, methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const backendConnections = new Map() // backendName -> Promise<{ connection, child, sessions }>

function forSession(sessions, sessionId, what) {
  const entry = sessions.get(sessionId)
  if (!entry) throw new Error(`unknown ACP session for ${what}: ${sessionId}`)
  return entry
}

function connectBackend(backend, env) {
  const command = backend.command()
  const args = backend.args()
  // Without this, the spawned backend only sees the LISTENER process's own
  // process.env — never whatever's in .env (ANTHROPIC_API_KEY,
  // CLAUDE_CODE_USE_BEDROCK, AWS_REGION, etc.), since loadEnv() reads .env
  // into a plain JS object and never injects it into process.env anywhere.
  // Confirmed the hard way: without this, claude-agent-acp silently fell
  // back to its own OAuth flow and failed with a stale/expired session
  // instead of using the configured Bedrock credentials.
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } })
  const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
  const sessions = new Map()

  const app = client({ name: 'team-slack-bridge' })
    .onRequest(methods.client.session.requestPermission, ctx => forSession(sessions, ctx.params.sessionId, 'requestPermission').onPermissionRequest(ctx.params))
    .onRequest(methods.client.fs.readTextFile, ctx => forSession(sessions, ctx.params.sessionId, 'readTextFile').fsHandlers.readTextFile(ctx.params))
    .onRequest(methods.client.fs.writeTextFile, ctx => forSession(sessions, ctx.params.sessionId, 'writeTextFile').fsHandlers.writeTextFile(ctx.params))
    .onRequest(methods.client.terminal.create, ctx => forSession(sessions, ctx.params.sessionId, 'createTerminal').terminalHandlers.createTerminal(ctx.params))
    .onRequest(methods.client.terminal.output, ctx => forSession(sessions, ctx.params.sessionId, 'terminalOutput').terminalHandlers.terminalOutput(ctx.params))
    .onRequest(methods.client.terminal.waitForExit, ctx => forSession(sessions, ctx.params.sessionId, 'waitForTerminalExit').terminalHandlers.waitForTerminalExit(ctx.params))
    .onRequest(methods.client.terminal.kill, ctx => forSession(sessions, ctx.params.sessionId, 'killTerminal').terminalHandlers.killTerminal(ctx.params))
    .onRequest(methods.client.terminal.release, ctx => forSession(sessions, ctx.params.sessionId, 'releaseTerminal').terminalHandlers.releaseTerminal(ctx.params))
    .onNotification(methods.client.session.update, ctx => {
      sessions.get(ctx.params.sessionId)?.updateQueue?.push({ kind: 'session_update', notification: ctx.params, update: ctx.params.update })
    })

  const connection = app.connect(stream)

  return connection.agent
    .request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    })
    .then(initializeResponse => ({ connection, child, sessions, initializeResponse }))
}

export function getBackendConnection(backend, env) {
  if (!backendConnections.has(backend.name)) backendConnections.set(backend.name, connectBackend(backend, env))
  return backendConnections.get(backend.name)
}

// Called once a session/new (or resumed/loaded) session is established,
// before any prompt is sent — registers the handlers the agent's own
// requests for this session will be dispatched to. `updateQueue` is only
// set for resumed/loaded sessions (see createUpdateQueue below); sessions
// created via buildSession() get their updates from the SDK's own
// ActiveSession instead and never populate it.
export function registerSession(sessions, sessionId, { fsHandlers, terminalHandlers, onPermissionRequest, updateQueue }) {
  sessions.set(sessionId, { fsHandlers, terminalHandlers, onPermissionRequest, updateQueue })
}

export function unregisterSession(sessions, sessionId) {
  sessions.delete(sessionId)
}

export function resetBackendConnections() {
  backendConnections.clear()
}

// A minimal FIFO async queue standing in for the SDK's private
// `ActiveSession` machinery, which the public API only builds for
// session/new — session/load and session/resume have no equivalent public
// builder, so resumed sessions get this instead, fed by the global
// session/update tap above. `push` also accepts the synthetic `{kind:
// 'stop', response}` message once a prompt resolves, mirroring
// ActiveSession's own documented behavior ("the same completion is also
// queued as a stop message for nextUpdate()").
export function createUpdateQueue() {
  const pending = []
  let waiting = null
  return {
    push(message) {
      if (waiting) {
        const resolve = waiting
        waiting = null
        resolve(message)
      } else {
        pending.push(message)
      }
    },
    next() {
      if (pending.length) return Promise.resolve(pending.shift())
      return new Promise(resolve => {
        waiting = resolve
      })
    },
  }
}
