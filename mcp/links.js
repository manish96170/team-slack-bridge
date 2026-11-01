// Optional `link` argument on the local tools that address one message or one
// thread (D72). A Slack permalink already carries the channel and timestamp,
// so these tools accept `link` instead of `channel` + `ts`/`threadTs`.
//
// The wrapper is applied to a COPY of each tool: the base schemas in
// mcp/schema.js (and therefore the remote/hosted registry, which imports them
// directly) are untouched. An explicit channel/ts/threadTs always wins over
// the link, and `link` is stripped before the handler runs, so no handler
// needs to know it exists.

import { applyLinkToArgs } from '../core/links.js'

const LINK_DESCRIPTION =
  'A Slack message permalink (https://<workspace>.slack.com/archives/<channel>/p<digits>[?thread_ts=…]). Use it instead of channel + timestamp; any explicit channel/ts/threadTs argument takes precedence. The link\'s workspace is NOT checked against the active account — make sure the account matches the link\'s workspace.'

// tool name → { argument: 'channel' | 'ts' | 'thread' }; a leading '?' marks an
// argument as optional (filled from the link when it carries it).
export const LINK_SUPPORT = {
  slack_get_thread: { channel: 'channel', threadTs: 'thread' },
  slack_query_messages: { channel: 'channel' },
  slack_reply: { channel: 'channel', threadTs: 'thread' },
  slack_react: { channel: 'channel', ts: 'ts' },
  slack_react_as_user: { channel: 'channel', ts: 'ts' },
  slack_unreact: { channel: 'channel', ts: 'ts' },
  slack_unreact_as_user: { channel: 'channel', ts: 'ts' },
  slack_update_message: { channel: 'channel', ts: 'ts' },
  slack_update_message_as_user: { channel: 'channel', ts: 'ts' },
  slack_delete_message: { channel: 'channel', ts: 'ts' },
  slack_delete_message_as_user: { channel: 'channel', ts: 'ts' },
  slack_upload_file: { channel: '?channel', threadTs: '?thread' },
  slack_upload_file_as_user: { channel: '?channel', threadTs: '?thread' },
  slack_call: { channel: '?channel', threadTs: '?thread' },
  slack_pin: { channel: 'channel', ts: '?ts' },
  slack_bookmark: { channel: 'channel' },
}

export function withLinkSupport(tool, mapping) {
  const schema = tool.inputSchema
  const provided = Object.keys(mapping).filter(key => (schema.required || []).includes(key))
  const inputSchema = {
    ...schema,
    properties: { ...schema.properties, link: { type: 'string', description: LINK_DESCRIPTION } },
    required: (schema.required || []).filter(key => !provided.includes(key)),
    'x-linkProvides': provided,
  }
  return {
    ...tool,
    inputSchema,
    handler: async (args, ctx) => {
      const applied = applyLinkToArgs(args, mapping)
      if (!applied.ok) return applied
      return tool.handler(applied.args, ctx)
    },
  }
}

export function applyLinkSupport(tools) {
  const wrapped = { ...tools }
  for (const [name, mapping] of Object.entries(LINK_SUPPORT)) {
    if (wrapped[name]) wrapped[name] = withLinkSupport(wrapped[name], mapping)
  }
  return wrapped
}
