// Argument schemas, shared between the local and (future) remote registries
// (PLAN §5). A missing required argument is rejected, not guessed (§6.3) —
// that rejection happens in the MCP client/server plumbing via these
// `required` lists.
//
// Deliberately absent from every schema here, on every profile: `username`,
// `icon_url`, `icon_emoji`. Nothing in this repo implements
// `chat:write.customize` — see D5b / §11.6 #1. A test (test/mcp-validation.test.js)
// asserts these three keys are absent so a future refactor that forwards
// unknown fields to Slack fails here, not in a channel.

// Used only by the local multi-account MCP daemon (listen/mcp-http.js,
// PLAN D21/D22) to add an optional `account` selector on top of every
// existing schema, without touching the schemas used by the stdio server
// or the remote/hosted profile.
export function withAccountField(schema) {
  return { ...schema, properties: { ...schema.properties, account: { type: 'string', description: 'Named account from accounts.json; omit for the default account' } } }
}

// The remote/hosted profile has no user tokens, no SLACK_USER_TOKEN-backed
// "locally authorized human" identity at all (D20) — `viaBot`/
// `anonymousMessage` are local-only concepts that mean nothing there, and
// `mcp/tools.remote.js`'s handlers never read either field (always the bot
// token, unconditionally). Before this (found live during a review, D68),
// `mcp/tools.remote.js` reused these same local schemas wholesale, so a
// remote client's `tools/list` still advertised `viaBot`/`anonymousMessage`
// with local-identity-specific descriptions ("send as the locally
// authorized human") that are flatly untrue remotely, and `additionalProperties:
// false` would have silently accepted-then-ignored either field if a client
// passed one, rather than rejecting it. This strips both so an unknown-field
// validation error (`mcp/validation.js`'s `additionalProperties:false` check)
// is the actual, honest result of passing either one to a remote tool.
export function withoutBotIdentityFields(schema) {
  const { viaBot, anonymousMessage, ...rest } = schema.properties || {}
  return { ...schema, properties: rest }
}

export const schemas = {
  slack_post: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel name (#x) or ID' },
      text: { type: 'string' },
      threadTs: { type: 'string' },
      idempotencyKey: { type: 'string' },
      viaBot: {
        type: 'boolean',
        description:
          'Default false: send as the locally authorized human (SLACK_USER_TOKEN) so it is a real, editable/deletable Slack message of yours. Set true to send as the shared bot instead (SLACK_BOT_TOKEN) — the text then gets a visible "sent via bot by" attribution footer and is journaled to local_audit. DO NOT set this to true unless the human explicitly asked for a bot-branded or anonymous message in THIS request — a routine status update, completion notice, or production/approval message should still go as the human by default; omit this field rather than guessing it should be true.',
      },
      anonymousMessage: {
        type: 'boolean',
        description:
          'Only meaningful with viaBot:true. Omit to use this install\'s configured default (slack-config.json\'s botSend.anonymousMessageDefault, false unless set); pass true/false explicitly to override that default for this one call. If this install cannot identify its sender (no owner.slackUserId configured), viaBot:true is REFUSED unless the resolved value is true. If true, the public bot-posted text omits the sender attribution footer — but if the sender IS identified, they still privately receive a tracking DM of what was sent and to whom (unless botSendTracking.enabled is false). DO NOT set this to true to work around a viaBot refusal — that refusal exists specifically to stop an anonymous send nobody asked for; surface the refusal to the human and let THEM decide, never retry with anonymousMessage:true on your own.',
      },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'text'],
    additionalProperties: false,
  },
  slack_reply: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      threadTs: { type: 'string' },
      text: { type: 'string' },
      idempotencyKey: { type: 'string' },
      viaBot: {
        type: 'boolean',
        description:
          'Default false: reply as the locally authorized human (SLACK_USER_TOKEN). Set true to reply as the shared bot instead — carries an attribution footer and is journaled to local_audit. DO NOT set this to true unless the human explicitly asked for a bot-branded or anonymous message in THIS request; omit this field rather than guessing it should be true.',
      },
      anonymousMessage: {
        type: 'boolean',
        description:
          'Same as slack_post\'s anonymousMessage (including the config-default fallback) — only meaningful with viaBot:true. DO NOT set this to true to work around a viaBot refusal; surface the refusal to the human instead.',
      },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'threadTs', 'text'],
    additionalProperties: false,
  },
  slack_react: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      ts: { type: 'string' },
      emoji: { type: 'string', description: 'Emoji name without colons, e.g. "eyes"' },
      viaBot: {
        type: 'boolean',
        description: 'Default false: react as the locally authorized human (SLACK_USER_TOKEN). Set true to react as the shared bot instead (SLACK_BOT_TOKEN).',
      },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'ts', 'emoji'],
    additionalProperties: false,
  },
  slack_react_as_user: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      ts: { type: 'string' },
      emoji: { type: 'string', description: 'Emoji name without colons, e.g. "eyes"' },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'ts', 'emoji'],
    additionalProperties: false,
  },
  slack_unreact: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      ts: { type: 'string' },
      emoji: { type: 'string', description: 'Emoji name without colons, e.g. "eyes"' },
      viaBot: {
        type: 'boolean',
        description: 'Default false: remove the locally authorized human\'s reaction (SLACK_USER_TOKEN). Set true to remove the shared bot\'s reaction instead (SLACK_BOT_TOKEN).',
      },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'ts', 'emoji'],
    additionalProperties: false,
  },
  slack_unreact_as_user: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      ts: { type: 'string' },
      emoji: { type: 'string', description: 'Emoji name without colons, e.g. "eyes"' },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'ts', 'emoji'],
    additionalProperties: false,
  },
  slack_update_message: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      ts: { type: 'string' },
      text: { type: 'string' },
      viaBot: {
        type: 'boolean',
        description:
          'Default false: edit as the locally authorized human (SLACK_USER_TOKEN) — use this for a message created by the (also default) as-user slack_post/slack_reply/slack_dm. Set true to edit a message previously posted by this install\'s bot token instead (SLACK_BOT_TOKEN).',
      },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'ts', 'text'],
    additionalProperties: false,
  },
  slack_update_message_as_user: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      ts: { type: 'string' },
      text: { type: 'string' },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'ts', 'text'],
    additionalProperties: false,
  },
  slack_delete_message: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      ts: { type: 'string' },
      viaBot: {
        type: 'boolean',
        description:
          'Default false: delete as the locally authorized human (SLACK_USER_TOKEN) — use this for a message created by the (also default) as-user slack_post/slack_reply/slack_dm. Set true to delete a message previously posted by this install\'s bot token instead (SLACK_BOT_TOKEN).',
      },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'ts'],
    additionalProperties: false,
  },
  slack_delete_message_as_user: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      ts: { type: 'string' },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'ts'],
    additionalProperties: false,
  },
  slack_dm: {
    type: 'object',
    properties: {
      userId: { type: 'string' },
      text: { type: 'string' },
      viaBot: {
        type: 'boolean',
        description:
          'Default false: DM as the locally authorized human (SLACK_USER_TOKEN + user-token DM scope). Set true to DM as the shared bot instead — carries an attribution footer and is journaled to local_audit. DO NOT set this to true unless the human explicitly asked for a bot-branded or anonymous DM in THIS request — a routine status update, completion notice, or production/approval message should still go as the human by default; omit this field rather than guessing it should be true.',
      },
      anonymousMessage: {
        type: 'boolean',
        description:
          'Same as slack_post\'s anonymousMessage (including the config-default fallback) — only meaningful with viaBot:true. DO NOT set this to true to work around a viaBot refusal; surface the refusal to the human instead of retrying anonymously on your own.',
      },
      dryRun: { type: 'boolean' },
    },
    required: ['userId', 'text'],
    additionalProperties: false,
  },
  slack_dm_as_user: {
    type: 'object',
    properties: {
      userId: { type: 'string' },
      text: { type: 'string' },
      dryRun: { type: 'boolean' },
    },
    required: ['userId', 'text'],
    additionalProperties: false,
  },
  slack_post_as_user: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      text: { type: 'string' },
      threadTs: { type: 'string' },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'text'],
    additionalProperties: false,
  },
  slack_query_messages: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      sinceMinutes: { type: 'number' },
      limit: { type: 'number' },
    },
    required: ['channel'],
    additionalProperties: false,
  },
  slack_get_thread: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      threadTs: { type: 'string' },
    },
    required: ['channel', 'threadTs'],
    additionalProperties: false,
  },
  slack_search: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  slack_list_channels: {
    type: 'object',
    properties: {
      types: { type: 'string', description: "Slack conversation types CSV, e.g. 'public_channel,private_channel' (default) or add 'mpim,im'" },
      limit: { type: 'number' },
      cursor: { type: 'string' },
    },
    required: [],
    additionalProperties: false,
  },
  slack_upload_file: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute or cwd-relative path to a local file (e.g. a screenshot or video)' },
      filename: { type: 'string', description: 'Overrides the uploaded filename; defaults to the basename of filePath' },
      title: { type: 'string' },
      channel: { type: 'string', description: 'Channel to share the uploaded file into, e.g. for evidence in an MR announcement thread' },
      threadTs: { type: 'string' },
      dryRun: { type: 'boolean' },
    },
    required: ['filePath'],
    additionalProperties: false,
  },
  slack_upload_file_as_user: {
    type: 'object',
    properties: {
      filePath: { type: 'string', description: 'Absolute or cwd-relative path to a local file (e.g. a screenshot or video)' },
      filename: { type: 'string', description: 'Overrides the uploaded filename; defaults to the basename of filePath' },
      title: { type: 'string' },
      channel: { type: 'string' },
      threadTs: { type: 'string' },
      dryRun: { type: 'boolean' },
    },
    required: ['filePath'],
    additionalProperties: false,
  },
  slack_resolve_user: {
    type: 'object',
    properties: {
      handle: { type: 'string' },
    },
    required: ['handle'],
    additionalProperties: false,
  },
  slack_lookup_user: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'A Slack member ID (U...), an email address, an @handle, a display name, or a real name' },
      mode: {
        type: 'string',
        enum: ['auto', 'id', 'email', 'handle', 'name'],
        description: '"auto" (default) infers id/email/handle from the query shape. "handle" and "name" both search the live directory the same way.',
      },
      includeEmail: { type: 'boolean', description: 'Default false — omit email from the result even when Slack returns it, to minimize unnecessary PII exposure.' },
      tokenSource: {
        type: 'string',
        enum: ['bot', 'user'],
        description: 'Default "user" (SLACK_USER_TOKEN, the locally authorized human). Pass "bot" to use the shared bot token instead; this is explicit and never a silent fallback, and the resolved tokenSource is always echoed back in the result.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  slack_doctor: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  slack_schedule_message: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      text: { type: 'string' },
      threadTs: { type: 'string' },
      postAt: { type: ['string', 'number'], description: 'ISO-8601 timestamp or Unix seconds, 10s to 120d in the future' },
      asUser: { type: 'boolean' },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'text', 'postAt'],
    additionalProperties: false,
  },
  slack_delete_scheduled_message: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      scheduledMessageId: { type: 'string' },
      asUser: { type: 'boolean' },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'scheduledMessageId'],
    additionalProperties: false,
  },
  slack_list_scheduled_messages: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      limit: { type: 'number' },
      asUser: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  slack_ask: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'Slack user ID to DM the question to' },
      question: { type: 'string' },
      kind: { type: 'string', enum: ['question', 'approval'], description: "'approval' shows Approve/Deny buttons; requires the listener running" },
      options: { type: 'array', items: { type: 'string' }, description: "Button labels for kind:'approval'. Default ['Approve','Deny']" },
      timeoutSeconds: { type: 'number' },
      captureMode: { type: 'string', enum: ['listener', 'poll'], description: "'poll' only works for kind:'question'" },
    },
    required: ['userId', 'question'],
    additionalProperties: false,
  },
  slack_progress_start: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      label: { type: 'string' },
      detail: { type: 'string' },
      threadTs: { type: 'string' },
      idempotencyKey: { type: 'string' },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'label'],
    additionalProperties: false,
  },
  slack_progress_update: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      ts: { type: 'string' },
      label: { type: 'string' },
      status: { type: 'string' },
      detail: { type: 'string' },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'ts', 'label'],
    additionalProperties: false,
  },
  slack_progress_finish: {
    type: 'object',
    properties: {
      channel: { type: 'string' },
      ts: { type: 'string' },
      label: { type: 'string' },
      detail: { type: 'string' },
      ok: { type: 'boolean' },
      dryRun: { type: 'boolean' },
    },
    required: ['channel', 'ts', 'label'],
    additionalProperties: false,
  },
  slack_publish_home: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'Slack user ID whose Home tab to (re)publish' },
      dryRun: { type: 'boolean' },
    },
    required: ['userId'],
    additionalProperties: false,
  },
  slack_agent_session_create: {
    type: 'object',
    properties: {
      source: { type: 'string' },
      slackChannel: { type: 'string' },
      slackThreadTs: { type: 'string' },
      kind: { type: 'string' },
      metadata: { type: 'object' },
    },
    required: [],
    additionalProperties: false,
  },
}
