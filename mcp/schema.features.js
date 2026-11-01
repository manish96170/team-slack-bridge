// Argument schemas for the D72 feature tools. Spread into `schemas`
// (mcp/schema.js). Several tools are action-based (one tool, an `action`
// enum) so the registry grows by a dozen tools rather than three dozen;
// per-action requirements are enforced in the handlers, which return the
// usual structured { ok:false, error } instead of a protocol error.

const DRY_RUN = { type: 'boolean', description: 'Resolve and validate the call and return what would be sent to Slack, without sending anything.' }
const TOKEN_SOURCE = {
  type: 'string',
  enum: ['user', 'bot'],
  description: 'Default "user": the locally authorized human (SLACK_USER_TOKEN). "bot" uses SLACK_BOT_TOKEN instead — explicit, never a silent fallback; the token source used is echoed back in the result where the tool reports it.',
}

export const featureSchemas = {
  slack_resolve_link: {
    type: 'object',
    properties: {
      link: { type: 'string', description: 'A Slack message permalink, e.g. https://<workspace>.slack.com/archives/C0123ABCD/p1793337025613279[?thread_ts=…]' },
    },
    required: ['link'],
    additionalProperties: false,
  },
  slack_call: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'update', 'end', 'info'], description: 'start: register a call and post it as a native call card; update: change title/joinUrl; end: mark it finished; info: read it back.' },
      channel: { type: 'string', description: 'start: conversation to post the call card in' },
      threadTs: { type: 'string', description: 'start: post the card inside this thread' },
      title: { type: 'string', description: 'start/update: call title shown on the card' },
      joinUrl: { type: 'string', description: 'start/update: https join link of a call hosted elsewhere (Meet, Zoom, Teams…). Omit on start to get a fresh Jitsi room.' },
      userIds: { type: 'array', items: { type: 'string' }, description: 'start: Slack user IDs to list as participants' },
      post: { type: 'boolean', description: 'start: default true. false registers the call without posting the card (the call id is returned).' },
      callId: { type: 'string', description: 'update/end/info: the call id returned by start (R…)' },
      durationSeconds: { type: 'number', description: 'end: how long the call lasted' },
      dryRun: DRY_RUN,
    },
    required: ['action'],
    additionalProperties: false,
  },
  slack_huddle_status: {
    type: 'object',
    properties: {
      userIds: { type: 'array', items: { type: 'string' }, description: 'Slack user IDs to check' },
      channel: { type: 'string', description: 'Check the members of this conversation (capped by limit)' },
      limit: { type: 'number', description: 'Max users to check (default 50, max 200); truncation is reported' },
      tokenSource: TOKEN_SOURCE,
    },
    required: [],
    additionalProperties: false,
  },
  slack_canvas: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'edit', 'share', 'sections', 'read', 'delete'] },
      title: { type: 'string', description: 'create: canvas title (not used for a channel canvas)' },
      markdown: { type: 'string', description: 'create/edit: canvas content as markdown' },
      channelId: { type: 'string', description: 'create: make the channel canvas for this conversation instead of a standalone canvas' },
      canvasId: { type: 'string', description: 'edit/share/sections/read/delete: canvas ID (F…)' },
      operation: { type: 'string', enum: ['insert_at_end', 'insert_at_start', 'insert_after', 'insert_before', 'replace', 'delete'], description: 'edit: default insert_at_end. insert_after/insert_before/delete/replace-a-section need sectionId.' },
      sectionId: { type: 'string', description: 'edit: target section (see action "sections")' },
      accessLevel: { type: 'string', enum: ['read', 'write'], description: 'share: default read' },
      channelIds: { type: 'array', items: { type: 'string' }, description: 'share: conversations to share with' },
      userIds: { type: 'array', items: { type: 'string' }, description: 'share: users to share with' },
      containsText: { type: 'string', description: 'sections: find sections containing this text' },
      sectionTypes: { type: 'array', items: { type: 'string' }, description: 'sections: e.g. ["h1","h2","h3","any_header"]' },
      maxChars: { type: 'number', description: 'read: max characters returned (default 20000)' },
      confirm: { type: 'boolean', description: 'delete: must be true, and only after the human approved deleting this exact canvas.' },
      dryRun: DRY_RUN,
    },
    required: ['action'],
    additionalProperties: false,
  },
  slack_pin: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'remove', 'list'] },
      channel: { type: 'string' },
      ts: { type: 'string', description: 'add/remove: timestamp of the message to pin/unpin' },
      dryRun: DRY_RUN,
    },
    required: ['action', 'channel'],
    additionalProperties: false,
  },
  slack_bookmark: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'list', 'edit', 'remove'] },
      channel: { type: 'string' },
      title: { type: 'string', description: 'add/edit: bookmark title' },
      url: { type: 'string', description: 'add/edit: http(s) URL' },
      emoji: { type: 'string', description: 'add/edit: optional emoji, e.g. ":book:"' },
      bookmarkId: { type: 'string', description: 'edit/remove: bookmark ID (Bk…), from list' },
      dryRun: DRY_RUN,
    },
    required: ['action', 'channel'],
    additionalProperties: false,
  },
  slack_reminder: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'list', 'complete', 'delete'] },
      text: { type: 'string', description: 'add: what to be reminded of' },
      time: { type: ['string', 'number'], description: 'add: ISO 8601 date-time, a Unix timestamp, seconds from now, or natural language ("in 15 minutes", "tomorrow at 9am")' },
      userId: { type: 'string', description: 'add: remind ANOTHER user instead of yourself. Requires confirm:true after the human approved this exact reminder for that person.' },
      confirm: { type: 'boolean' },
      reminderId: { type: 'string', description: 'complete/delete: reminder ID (Rm…), from list' },
      dryRun: DRY_RUN,
    },
    required: ['action'],
    additionalProperties: false,
  },
  slack_usergroup_lookup: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Handle, name or ID (S…) of a user group. Omit to list groups.' },
      includeMembers: { type: 'boolean', description: 'Also return member user IDs (only when at most 5 groups match).' },
      includeDisabled: { type: 'boolean' },
      tokenSource: TOKEN_SOURCE,
    },
    required: [],
    additionalProperties: false,
  },
  slack_file: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['info', 'list', 'read'], description: 'info: metadata; list: recent files (optionally per channel/user); read: download content — text and canvases inline, other files saved locally and returned as a path.' },
      fileId: { type: 'string', description: 'info/read: file ID (F…), from a message\'s files[] array' },
      channel: { type: 'string', description: 'list: only files shared in this conversation' },
      userId: { type: 'string', description: 'list: only files from this user' },
      types: { type: 'string', description: 'list: Slack types CSV, e.g. "images,pdfs,spaces"' },
      count: { type: 'number', description: 'list: max files (default 20, max 100)' },
      maxChars: { type: 'number', description: 'read: max characters of text returned (default 20000)' },
      tokenSource: TOKEN_SOURCE,
    },
    required: ['action'],
    additionalProperties: false,
  },
  slack_reactions: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'list'], description: 'get: who reacted with what on one message; list: messages a user has reacted to.' },
      channel: { type: 'string', description: 'get: conversation ID of the message' },
      ts: { type: 'string', description: 'get: timestamp of the message' },
      emoji: { type: 'string', description: 'Only report this emoji (e.g. "white_check_mark" or ":white_check_mark:"). For list, messages without it are dropped.' },
      userId: { type: 'string', description: 'list: whose reactions to list (default: the token\'s own user)' },
      count: { type: 'number', description: 'list: items per page (default 20, max 100)' },
      cursor: { type: 'string', description: 'list: pagination cursor from a previous nextCursor' },
      tokenSource: TOKEN_SOURCE,
    },
    required: ['action'],
    additionalProperties: false,
  },
  slack_set_status: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Status text (max 100 characters)' },
      emoji: { type: 'string', description: 'Status emoji, e.g. ":headphones:" or "headphones"' },
      expiresInMinutes: { type: 'number', description: 'Clear automatically after this many minutes; omit for no expiry' },
      clear: { type: 'boolean', description: 'Clear the status instead of setting one' },
      dryRun: DRY_RUN,
    },
    required: [],
    additionalProperties: false,
  },
  slack_set_presence: {
    type: 'object',
    properties: {
      presence: { type: 'string', enum: ['auto', 'away'] },
      dryRun: DRY_RUN,
    },
    required: ['presence'],
    additionalProperties: false,
  },
  slack_dnd: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['snooze', 'end', 'info'], description: 'snooze: pause notifications; end: resume them; info: current Do Not Disturb state.' },
      minutes: { type: 'number', description: 'snooze: 1–1440' },
      userId: { type: 'string', description: 'info: another user\'s DND state (default: you)' },
      dryRun: DRY_RUN,
    },
    required: ['action'],
    additionalProperties: false,
  },
}
