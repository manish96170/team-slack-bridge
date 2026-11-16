// A stand-in for Bolt's App (PLAN D75). createListener registers its handlers on
// whatever `app` it is given; this one just remembers them and replays Slack
// events that arrived some other way (forwarded by the network hub), so the
// host runs the exact same session code as a normal Socket Mode listener.

export function createVirtualApp() {
  const handlers = { events: new Map(), messages: [], actions: [], commands: new Map(), shortcuts: new Map(), views: new Map() }
  return {
    event: (name, fn) => handlers.events.set(name, fn),
    message: fn => handlers.messages.push(fn),
    action: (pattern, fn) => handlers.actions.push({ pattern, fn }),
    command: (name, fn) => handlers.commands.set(name, fn),
    shortcut: (id, fn) => handlers.shortcuts.set(id, fn),
    view: (id, fn) => handlers.views.set(id, fn),
    error: () => {},
    start: async () => {},
    stop: async () => {},

    // Only the event kinds the hub forwards are replayed; anything else is
    // reported as unhandled so a caller can tell.
    async dispatch(forwarded) {
      if (forwarded?.type === 'app_mention') {
        const fn = handlers.events.get('app_mention')
        if (fn) await fn({ event: forwarded.event })
        return { handled: Boolean(fn) }
      }
      if (forwarded?.type === 'message') {
        for (const fn of handlers.messages) await fn({ message: forwarded.message })
        return { handled: handlers.messages.length > 0 }
      }
      if (forwarded?.type === 'action') {
        const id = forwarded.action?.action_id || ''
        let handled = false
        for (const { pattern, fn } of handlers.actions) {
          if (pattern instanceof RegExp ? pattern.test(id) : pattern === id) {
            await fn({ action: forwarded.action, body: forwarded.body, ack: async () => {} })
            handled = true
          }
        }
        return { handled }
      }
      if (forwarded?.type === 'event') {
        const fn = handlers.events.get(forwarded.name)
        if (fn) await fn({ event: forwarded.event, body: forwarded.body, client: forwarded.client })
        return { handled: Boolean(fn) }
      }
      if (forwarded?.type === 'command') {
        const fn = handlers.commands.get(forwarded.name)
        if (fn) await fn(forwarded.payload)
        return { handled: Boolean(fn) }
      }
      if (forwarded?.type === 'shortcut' || forwarded?.type === 'view') {
        const fn = (forwarded.type === 'shortcut' ? handlers.shortcuts : handlers.views).get(forwarded.id)
        if (fn) await fn(forwarded.payload)
        return { handled: Boolean(fn) }
      }
      return { handled: false }
    },
  }
}
