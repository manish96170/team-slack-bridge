// Host transport (PLAN D74). A "host" is whatever actually runs an agent
// session on a person's machine. The hub only ever talks to hosts through this
// small interface, so the embedded setup (the host is this very process) and a
// later deployed hub (the host is a laptop connected over an outbound
// WebSocket) are the same hub code with a different transport underneath.
//
// Host interface:
//   userId                      the Slack user whose machine this is
//   isOnline()                  true when the host can take a request right now
//   startSession(request)       start a session; resolves to the session result
//   stopSession({ id })         close one session row
//   restartSession({ id })      reopen a closed session row
//   stopAllFor(requesterId)     close every open session that requester started

export function createHostRegistry() {
  const hosts = new Map()
  return {
    register(host) {
      if (!host?.userId) throw new Error('host.userId required')
      hosts.set(host.userId, host)
    },
    unregister(userId) {
      hosts.delete(userId)
    },
    get(userId) {
      return hosts.get(userId) || null
    },
    list() {
      return [...hosts.keys()]
    },
  }
}

// In-process host: this listener IS the owner's machine. The operations are
// injected rather than imported so the hub stays free of a cycle through
// core/acp-sessions.js.
export function createLoopbackHost({ userId, startSession, stopSession, restartSession, stopAllFor }) {
  return {
    userId,
    kind: 'loopback',
    isOnline: () => true,
    startSession,
    stopSession,
    restartSession,
    stopAllFor,
  }
}
