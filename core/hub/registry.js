// One hub per listener, found by the listener's DB path. Keyed by dbPath (not a
// module-level singleton) because one process can run several accounts, each
// with its own database, and their hubs must never see each other's sessions.
// Kept dependency-free so core/acp-sessions.js can ask "is a hub watching this
// listener?" without an import cycle back through the hub itself.

const hubsByDbPath = new Map()

export function registerHub(dbPath, hub) {
  if (dbPath) hubsByDbPath.set(dbPath, hub)
}

export function unregisterHub(dbPath) {
  hubsByDbPath.delete(dbPath)
}

export function getHub(dbPath) {
  return dbPath ? hubsByDbPath.get(dbPath) || null : null
}

// A session observer hears about every session as it is bound to a Slack thread.
// The network connector uses it to tell the hub which host owns which thread.
const observersByDbPath = new Map()

export function setSessionObserver(dbPath, fn) {
  if (!dbPath) return
  if (fn) observersByDbPath.set(dbPath, fn)
  else observersByDbPath.delete(dbPath)
}

export function notifySessionBound(dbPath, info) {
  try {
    observersByDbPath.get(dbPath)?.(info)
  } catch {}
}
