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

export const schemas = {
  slack_post: {
    type: 'object',
    properties: {
      channel: { type: 'string', description: 'Channel name (#x) or ID' },
      text: { type: 'string' },
      threadTs: { type: 'string' },
      idempotencyKey: { type: 'string' },
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
  slack_resolve_user: {
    type: 'object',
    properties: {
      handle: { type: 'string' },
    },
    required: ['handle'],
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
