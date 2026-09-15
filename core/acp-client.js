// Persistent ACP connections, one per backend, multiplexing many sessions
// via session/new rather than one process per Slack thread (per the
// research: ACP is designed for this). Built on the official
// @agentclientprotocol/sdk (PLAN: hand-rolling the full fs/terminal/
// permission/session-lifecycle surface here would be a materially bigger
// protocol-compliance risk than the small MCP surfaces this repo hand-rolls
// elsewhere — this is the "argued in writing" case for a new dependency,
// D7).
//
// Notification-based session/update streaming is intentionally NOT
// registered as a global handler here — the SDK's `ActiveSession.
// nextUpdate()` already owns that per session internally. This module only
// answers the agent's own REQUESTS (permission, fs, terminal), dispatched by
// sessionId to whichever session registered a handler via `registerSession`.

import { spawn } from 'node:child_process'
import { Writable, Readable } from 'node:stream'
import { client, ndJsonStream, methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const backendConnections = new Map() // backendName -> Promise<{ connection, child, sessions }>

function forSession(sessions, sessionId, what) {
  const entry = sessions.get(sessionId)
  if (!entry) throw new Error(`unknown ACP session for ${what}: ${sessionId}`)
  return entry
}

function connectBackend(backend) {
  const command = backend.command()
  const args = backend.args()
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] })
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

  const connection = app.connect(stream)

  return connection.agent
    .request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    })
    .then(() => ({ connection, child, sessions }))
}

export function getBackendConnection(backend) {
  if (!backendConnections.has(backend.name)) backendConnections.set(backend.name, connectBackend(backend))
  return backendConnections.get(backend.name)
}

// Called once a session/new response comes back, before any prompt is sent
// — registers the handlers the agent's own requests for this session will
// be dispatched to.
export function registerSession(sessions, sessionId, { fsHandlers, terminalHandlers, onPermissionRequest }) {
  sessions.set(sessionId, { fsHandlers, terminalHandlers, onPermissionRequest })
}

export function unregisterSession(sessions, sessionId) {
  sessions.delete(sessionId)
}

export function resetBackendConnections() {
  backendConnections.clear()
}
