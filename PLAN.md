# team-slack-bridge — build plan

Written 2026-09-09 from a session in `../custom-team-dashboard`. **Nothing here has been committed or
pushed** — this file is the only change made to this repo.

Read this before writing code. It records what already exists, what the dashboard has already DECIDED about
Slack (so the two do not drift), what to lift from the working sample next door, and the order to build in.

**Decisions already made — do not re-open these without a reason:**

| # | Decision | Where |
|---|---|---|
| D1 | One core, four surfaces; **an adapter may not contain behaviour** | §0 |
| D2 | The core takes **no ambient state** — tokens are parameters, never `process.env` reads inside core | §0 |
| D3 | Inbound is a **proposal** (a request to triage), never an instruction that executes itself | §2.3 |
| D4 | §14.6's DM password gate is **non-functional** — it guards a pull path while delivery is push | §2.7, §4.2 |
| D5 | The **remote profile leverages everything that is safe and nothing else**: channel post/reply/react, own-message edits, allow-listed reads, configured-user resolution, reduced `doctor`. User tokens, DMs and the listener are **absent from the code path**, not disabled by a flag. Fork to change | **§11**, **§11.6** |
| D5a | On remote, the **registry decides WHAT** (structural, unchangeable) and the **allow-list decides WHERE** (operator config). Neither can obtain the other | §11.6 |
| D5b | **No `chat:write.customize` on remote** — custom `username`/`icon_*` is visual impersonation that survives having no user tokens | §11.6 |
| D6 | Multi-workspace: **no** for the hosted profile — one deployment, one bot install, one workspace | §11.4 |
| D7 | Zero dependencies until one is argued for **in writing** | §7 |
| D8 | Socket Mode transport: **Bolt** (`@slack/bolt`), decided 2026-09-09 — Bolt already owns envelope/ack/redelivery semantics that a hand-rolled client would re-implement one bug at a time; this is D7's written reason | §3, §9 open Q1 |
| D9 | The listener is a **library first, process second**, and supports **both** run modes: `listen/socket.js`'s `createListener()` for the dashboard's supervisor to own in-process, and `cli/listen.js` as a thin standalone-process wrapper | §9 open Q2 |
| D10 | The idempotency ledger moved from a JSON file to **SQLite**, decided 2026-09-09 — the listener (D8/D9) can now post concurrently with a CLI/MCP/dashboard call against the same install, and a JSON read-modify-write is not safe under that | §9 open Q3, §4.1 |
| D11 | SQLite implementation: **`node:sqlite`** — built into Node (stable since 22.5, this repo targets 18+ so this is a soft floor bump worth noting), no npm dependency added | §9 open Q3 |
| D12 | Thread identity for review-requests (`{channel, thread_ts}` on the dashboard's `requests` row) is a **cross-repo dependency**, confirmed/fixed in `custom-team-dashboard` separately, not here | §9 open Q5 |
| D13 | The DM-reading gate (§4.2) is **sender identity + channel type** (unspoofable, Slack-asserted) **plus an explicit `dmAllowlist`** of additional user IDs. Allow-listed non-owner DMs classify as `dm-request` — never `self-dm`/`self-dm-start-now`, which stay owner-only per the dashboard's own §2.4 gate 1 | §4.2 |
| D14 | Human-in-the-loop `ask`/approve (added 2026-09-09, on request — not originally scoped): a running agent session DMs its question to the owner and BLOCKS until answered. **Approve/Deny buttons require the Socket Mode listener running** (a button click is a `block_actions` event, never a readable message — no poll-based equivalent exists); **free-text replies work via the listener (default) or a direct poll** (`captureMode: 'poll'`, togglable, question-kind only). Correlation between the asking process (short-lived MCP call) and the capturing process (long-lived listener) goes through the same local SQLite DB the ledger uses (`core/db.js`), not through Slack or in-process memory | §4.6 (new) |
| D15 | This repo now also exists as a **public snapshot** at `github.com/manish96170/team-slack-bridge` (2026-09-09) — a single fresh commit pushed from a `/tmp` copy, filtered through `git ls-files --cached --others --exclude-standard` (i.e. exactly what `.gitignore` allows) and grepped for token patterns before push. **This working directory's `.git` was never touched** — no commits, no remote changes, no branch switch happened here. The public repo is a point-in-time export, not a tracking remote; it will drift from this directory's ongoing uncommitted work unless someone deliberately re-syncs it | §12 (new) |
| D16 | **`core/slack.js` moved from hand-rolled `fetch` to `@slack/web-api`'s `WebClient`** (second real dependency, added without this entry originally — backfilled 2026-09-09 during review). Reason: built-in retry/rate-limit handling replaces the hand-rolled 429 loop, and it fixes the exact form-encoding bug the original README flagged (`conversations.list`'s `types` filter silently ignored on a JSON body) by construction. `core/query.js`'s manual `{ form: true }` option is gone — the client picks the right encoding itself | §7, §9a |
| D17 | `package.json`'s `engines` is **`>=26`** by owner request: stay on the current Node line rather than LTS. `.nvmrc` pins `26` for local dev as well. `node:sqlite` would permit a lower technical floor, but that is no longer the support target for this repo | §7 |
| D18 | **`org_deploy_enabled` left `false`** in the manifest (set to `true` then reverted same day, 2026-09-09, on request) — not wanted active yet. The code path this would enable was reasoned through and would only be a **manifest-level install-approval convenience**, not multi-workspace code support — flipping it later doesn't need any code change, only a manifest edit + reinstall, since `SLACK_BOT_TOKEN`/`slack-config.json`/`core/db.js` are still single-workspace by construction (D6). Real cross-workspace operation from ONE install (per-team token resolution via Bolt's `authorize` callback, a `team_id`-keyed config/DB) remains a separate, larger, not-built feature | §11.4 (references) |
| D19 | **Every default-false/optional surface is now asked about explicitly during setup** (2026-09-09, on request): `cli/setup.js init` (first-time) and `cli/setup.js features` (revisit later) both prompt for `http.enabled`, `slashCommands.enabled`, `agentSessions.enabled`, `openacp.enabled`, `slackbotMcp.enabled` — each with a one-line hint and "leave off if unsure" as the visible recommendation. `--enable-<x> true\|false` skips a given prompt non-interactively. Nothing changes the actual defaults (still `false`); this only makes the toggles discoverable instead of something you'd only find by reading `core/identity.js` | `cli/setup.js` |
| D20 | **Slackbot remote MCP uses `mcp/tools.remote.js`, never `mcp/tools.local.js`** (2026-09-10, review fix): DM, ask/approval, post-as-user, search, App Home publishing, scheduling, progress mutation, and agent-session creation are local-only and absent from the remote import path. Config may narrow the remote registry and choose channel allow-lists; it may not summon a local-only capability | §11.2 |
| D21 | **Multi-account support is local-profile-only** (2026-09-15, on request): D6 is unchanged for the remote/hosted profile — `mcp/tools.remote.js`/`mcp/http.js` never gain an `account` field, still one workspace per hosted deployment. For the *local* profile, an opt-in registry (`core/accounts.js`, `~/.team-slack-bridge/accounts.json`) maps named accounts to home directories, each with its own `.env`/`slack-config.json`/`.ledger.sqlite`. Absent that file, every account-aware function synthesizes a single `"default"` account pointing at today's `TSB_HOME` — byte-identical behavior to before this decision for anyone who never touches it | `core/accounts.js`, `cli/accounts.js` |
| D22 | **The local MCP HTTP daemon (`listen/mcp-http.js`) binds `127.0.0.1` only, hardcoded, never configurable to `0.0.0.0`** (2026-09-15) — same "absent by omission" principle as D5, applied to bind address instead of tool exposure. It exposes the FULL local tool set (unlike the remote profile's 9-tool restriction, D20) because anything able to reach a loopback-only port already has filesystem/env access to the same secrets. Default `accountMode` is `"single"` (behaves exactly like the existing stdio `mcp/server.js`, just reachable by multiple concurrent harnesses instead of one spawned subprocess); `accountMode:"multi"` additionally accepts an optional `account` argument per tool call, resolved via D21's registry. This is a separate surface from `slackbotMcp`/`mcp/http.js` — neither shares code nor config with the locked-down remote profile | `listen/mcp-http.js`, `cli/mcp-daemon.js` |
| D23 | **ACP agent sessions scope `fs`/`terminal` access to a named repo registry** (2026-09-15) — `core/repos.js`, same shape as `core/accounts.js`: a trigger picks a short name, never a raw filesystem path. Every path an agent requests via `fs/read_text_file`/`fs/write_text_file`, and every `cwd` it requests for `terminal/create`, is checked against the session's registered repo root (`core/acp-fs.js`'s `assertInsideRepo`) and rejected if it escapes — same "absent by omission" principle as D5, applied to filesystem/process scope | `core/repos.js`, `core/acp-fs.js`, `core/acp-terminal.js` |
| D24 | **Starting an ACP agent session (any trigger) is gated to `config.owner` plus an explicit `agentSessions.allowedUsers` list** (2026-09-15) — mirrors the `dmAllowlist` pattern, never gated by channel membership alone. A session can run real shell commands and edit real files on the machine running the listener; this is a materially bigger blast radius than anything else in this repo and gets its own gate, independent of who the bot can see in a channel | `core/acp-sessions.js`'s `isAllowedToStartSession` |
| D25 | **Thread↔session/backend/repo/ACP-`sessionId` mapping lives inside `agent_sessions.metadata`** (existing free-form JSON column, 2026-09-15) — no `ALTER TABLE`, no schema migration; `core/db.js` stays migration-free by construction | `core/acp-sessions.js` |
| D26 | **ACP agent sessions are local-profile-only** (2026-09-15), same posture as D21/D22 — never added to `mcp/tools.remote.js`/`mcp/http.js`. Only reachable via the Socket Mode listener (`listen/socket.js`'s `/agent-session` slash command and thread-reply routing) | `listen/socket.js`, `core/acp-sessions.js` |
| D27 | **ACP client transport uses the official `@agentclientprotocol/sdk`** (2026-09-15, D7's written justification for a new dependency) — the ACP v1 surface needed here (session lifecycle, `fs/*`, `terminal/*`, `session/request_permission`, `session/update` streaming) is large enough that hand-rolling JSON-RPC framing and protocol compliance for all of it would be a materially bigger correctness risk than the small MCP surfaces this repo hand-rolls elsewhere (3-4 methods each). The SDK is official (`agentclientprotocol` org, successor to the deprecated `@zed-industries/agent-client-protocol`), actively maintained, and has zero runtime dependencies of its own | `core/acp-client.js` |

---

## 0. The one architectural decision everything else follows

**One core, four surfaces.** Every capability is implemented exactly once as a plain function in `core/`, and
each way of reaching it is a thin adapter over that function:

| Surface | For | Entry point |
|---|---|---|
| **Direct** (today) | scripts, CI, a human at a terminal | `node post.js …`, or `import` the core |
| **MCP server (local)** | anyone whose client speaks MCP — pull the repo, point a client at it | `mcp/server.js` over **stdio**, full tool set |
| **MCP server (remote)** | a hosted instance anyone authorised may call | the same core over **Streamable HTTP**, **channel-post only** — see §11 |
| **Skill** | Claude Code, invoked by name | `skill/SKILL.md` shelling out to the CLI |
| **Dashboard agent** | `custom-team-dashboard`'s `slack-message` utility agent | the dashboard calls the CLI or imports the core |

The rule that makes this worth stating: **an adapter may not contain behaviour.** If a surface needs a
decision made — which channel, whether a person may post as themselves, whether a mention becomes a task —
that decision belongs in `core/` where all four surfaces get it and one test covers it. The moment the MCP
server grows its own idea of what "post as user" means, there are two products with one name.

Those two MCP rows are one server with two **profiles**, and the difference is structural rather than
configured: the remote profile is a tool registry that never imports the risky functions (§11.2). That is the
second reason for the rule below.

Corollary worth writing down now: **the core takes no ambient state.** No reading `process.env` from inside a
core function, no `console.log`. Config in, result out, errors as values. That is what makes the same function
testable, MCP-safe (stdout is the protocol — see §6.3) and usable in-process by the dashboard.

---

## 1. What exists today

| File | Lines | What it does |
|---|---|---|
| `post.js` | 76 | CLI: post to a channel as the bot, or as a specific person (`--as-user`), or DM a user |
| `get-user-token.js` | 82 | One-time OAuth flow that mints THIS person's user token into their own `.env` |
| `verify-dm.js` | 54 | Diagnostic: proves the bot can read DM history via `im:read`/`im:history`. Explicitly **not** the inbound listener |
| `env.js` | 22 | Reads `.env` from the repo directory. No dependency |
| `README.md` | 134 | Setup, scopes, and the design principles below |

**Design principles already committed to in the README** (keep these — the rest of this plan assumes them):

- One shared Slack **app/bot** for everyone; the bot never acts as a person.
- A **user token is inherently per-person** (Slack's OAuth only ever mints one for whoever authorised it).
  Each person runs `get-user-token` once, into their own local `.env`. No install holds anyone else's token.
- **Naming a person is not authorization.** If something posts "as whoever this request is from", the
  request's own origin must be verified against the named person. This library does not enforce that for a
  single-token install; a multi-person system must.
- **Every install is local and holds its own credentials.** Nothing account-specific ships in the repo.
- **Neither as-user posting nor DM-reading is on by default.** Both require deliberate setup.

Current shape: **outbound only, one token per install, zero dependencies.** The dependency count is worth
protecting; see §7.

---

## 2. What the dashboard has already decided (do not re-litigate)

The dashboard is `../custom-team-dashboard`. Its `PLAN.md` §14 is the Slack section and `FLOWS.md` §6a/§6b are
the UI and the request lifecycle. These are decisions, not suggestions — this repo has to be buildable against
them, because the dashboard's `slack-message` utility agent (PLAN §16) is one of the four surfaces.

1. **Two integrations, different maturity.** Outbound is cheap and v1. Inbound is explicitly **provisional
   architecture**, not settled.
2. **Outbound is delivered through an outbox, not a synchronous call.** The dashboard writes to an `outbox`
   table and a consumer delivers with **dedup + retry + failure isolation**. So this repo's job is to be a
   reliable *deliverer* that is safe to retry — see §4.1 on idempotency.
3. **An inbound mention is a PROPOSAL, never an instruction.** It becomes a `requests` row in a triage queue
   (pending → accepted/declined → completed). Accepting is what creates a task. "Explicit beats inferred", the
   same rule as the dashboard's no-autonomous-merge.
4. **The self-DM exception has TWO gates.** Gate 1: the message is in the owner's own DM with the bot AND the
   sender is that owner — then it creates a task directly (`source: "slack-inbound-self"`), landing in
   `created`, still waiting on harness/model assignment. It does **not** spawn a run. Gate 2, on top: the text
   must contain a **whole-word** trigger — `start right now`, `start right away`, `srn`, `sra` — before it also
   auto-assigns defaults and starts. Never a substring match: `sra` inside "extras" must not fire.
   Anything that is not exactly this self-DM shape goes through the full pending flow regardless of wording.
5. **Two request types**: `review-request` (a tagged handle in the MR channel) and `team-request` (sprint
   changes, ticket asks, reassignment — bucketed separately, resolution deliberately left open).
6. **As-user posting is v1-backlog on the dashboard side**, gated on a real `callerIdentity`: the agent may use
   a person's user token only when `requestedPersonName == callerIdentity` as a **hard equality**, where
   `callerIdentity` is an authenticated principal, never a name from a prompt. **Refusals are logged, never
   silently dropped.**
7. **§14.6: the DM-reading password gate as originally specified DOES NOT WORK, and this is the single most
   important thing in this section.** It checks a **pull** path (`conversations.history`) while Slack delivers
   DMs over a **push** event subscription — so it never runs on the path it is meant to protect. Do not build
   inbound DM-reading against it. A replacement gate must sit on the event handler itself (§4.2).
8. **No hardcoded handles or channels.** Identity mapping and watched channels are per-install config
   (`slack-config.json`), collected at setup: name, Slack handle, Jira handle.
9. **Query/read is a later METHOD on the same agent** (`queryMessages`, `getThread`), not a new agent, and its
   scopes are already in the list.
10. **No integration is ever a hard dependency of the dashboard.** It must run correctly with zero
    integrations configured.

---

## 3. What to take from `../slack-bots/yadavbot` (and what not to)

That directory is a **Slack-provided sample app** — "Casey", an IT-support agent built with **Bolt for
JavaScript**, in two variants (`claude-agent-sdk/` and `openai-agents-sdk/`) sharing one listener layer. It is
the inbound half this repo does not have, already working.

**Worth lifting — it is the part that is fiddly and it is proven:**

- **Socket Mode.** `socket_mode_enabled: true` in its manifest. This is the decision that matters most for us:
  Socket Mode needs **no public URL, no ngrok, no inbound firewall hole** — it dials out. For a local-first
  tool (this repo's whole premise, and the dashboard's §15/§17 local-only stance) that is the only sane
  transport. It requires an **app-level token** (`xapp-…`) alongside the bot token.
- **The event subscription set** that actually delivers what we need:
  `app_mention`, `message.im`, `message.channels`, `message.groups`, `app_home_opened`.
- **The manifest as a file.** `claude-agent-sdk/manifest.json` is a complete, working app manifest — scopes,
  events, features. Copy its shape so setup becomes "paste this manifest" instead of twenty clicks.
- **Its scope list**, as a reference for what each feature actually costs:
  bot: `app_mentions:read, channels:history, chat:write, groups:history, im:history, im:read, im:write,
  reactions:write, reactions:read, users:read, assistant:write`.
- **Thread-context handling and `assistant:write`/agent-panel wiring**, if we ever want the bridge to answer in
  a thread rather than only post into one.
- **`.env.sample` discipline** and its OAuth variant (`app-oauth.js`) as a second reference for our
  `get-user-token.js`.

**Deliberately NOT lifting:**

- **The IT-support tools** (knowledge base, tickets, password reset, system status, permissions). Simulated
  demo data for a different product.
- **The two-framework split.** We are not shipping the same thing twice; the agent lives in the dashboard.
- **Bolt itself, unless it earns its place.** See §7 — this repo currently has **zero dependencies**, and Bolt
  brings a tree. Measure first: a Socket Mode client is a WebSocket plus a JSON envelope. If a hand-rolled
  listener is ~150 lines and testable, prefer it; if it turns into a re-implementation of Bolt's retry and
  envelope semantics, take Bolt and say so in one line here. **Decide this with a measurement, not a
  preference.**

---

## 4. Features

Grouped by what they need. Everything marked **new** does not exist yet. **Availability per profile is in
§11's table** — read it alongside this list, because roughly half of what follows is local-only by decision.

### 4.1 Outbound (extend what works)

- `postToChannel({ channel, text, blocks?, threadTs?, asUser? })` — today's `post.js`, moved into `core/` and
  given: **thread replies** (`thread_ts`), **Block Kit** payloads, and `unfurl_links` control. **new**
- `dm({ userHandleOrId, text, blocks? })` — exists; move to core.
- `reply({ channel, threadTs, text })` — **new**. Sugar over `postToChannel`, and the one the dashboard needs
  most: a review-request comes from a thread, and the answer belongs in that thread.
- `react({ channel, ts, emoji })` — **new**, `reactions:write`. Cheap, and the honest way to acknowledge an
  inbound request without posting noise ("👀 triaged").
- `updateMessage` / `deleteMessage` — **new**, `chat:update`/`chat:delete`. Needed for a status message that
  edits itself instead of posting six times.
- **Idempotency, because the dashboard retries.** Every send takes an optional `idempotencyKey`; the core keeps
  a small local ledger (a JSON file or SQLite — one dependency-free choice) of key → `{channel, ts}` and
  returns the previous result instead of posting twice. Without this, the outbox's retry is a duplicate-message
  generator. **new** — and note the dashboard learned this exact lesson in its own assignment path: claim the
  key BEFORE the side effect, not after.
- **Rate-limit handling.** Slack returns `429` with `Retry-After`; honour it, with a bounded number of retries
  and a **structured** failure. Never a bare throw into a caller that cannot tell "retry me" from "this will
  never work". **new**
- **[DONE 2026-09-09] `resolveMentions(text, config)`** — a plain literal `@handle` in posted text is never
  rendered as a real Slack mention by the API (only the `<@USERID>` syntax is); `core/identity.js` resolves any
  `@handle` matching `slack-config.json`'s `users` list into `<@USERID>` before `postToChannel`/`reply`/`dm`
  build their request body. An unmatched `@handle` is left exactly as typed — a wrong guess (tagging the wrong
  person) is worse than no substitution.
- **[DONE 2026-09-09] `scheduleMessage` / `deleteScheduledMessage` / `listScheduledMessages`** (`core/schedule.js`)
  — added on request, not originally scoped. Wraps Slack's own `chat.scheduleMessage` /
  `chat.deleteScheduledMessage` / `chat.scheduledMessages.list`; same `chat:write` scope as an immediate post, no
  new permission. Validates `postAt` client-side (10s–120d out, Slack's own bounds) before ever calling Slack.
  CLI: `cli/{schedule,unschedule,scheduled}.js`. MCP: `slack_schedule_message`,
  `slack_delete_scheduled_message`, `slack_list_scheduled_messages`.

### 4.2 Inbound (new — the big piece)

- `listen({ onEvent })` — Socket Mode client. Connects with the app-level token, handles the envelope
  (`ack` semantics matter: Slack redelivers if you do not ack, so an unacked handler is an infinite loop).
  **new**
- **Classification, pure and testable**: `classify(event, config) -> { kind, ... }` where kind is one of
  `review-request`, `team-request`, `self-dm`, `self-dm-start-now`, `ignore`. This is where §2.3 and §2.4 live,
  and it must be a **pure function of (event, config)** so the two gates and the whole-word trigger matching
  are covered by a table of cases with no Slack connection. **new**
  - Whole-word triggers only. `sra` in "extras" must not fire — that is a written requirement, so it gets an
    explicit negative test.
- **The replacement gate for DM-reading (§2.7).** The original password mechanism is non-functional because it
  guards a pull path while delivery is push. The gate must sit **on the event handler**, and must be something
  a message cannot spoof. Options to evaluate, in preference order:
  1. **Sender identity + channel type**, which Slack itself asserts in the event: `channel_type === "im"` AND
     `event.user === configuredOwnerUserId` (a Slack **user ID**, resolved once at setup — never a display
     name, which is user-editable). This is the cheapest correct gate and it is what §2.4's gate 1 already
     describes; a password adds nothing over it.
  2. **An explicit local allow-list of user IDs** for anyone else permitted to DM the bridge.
  3. A shared secret only if 1 and 2 prove insufficient — and if so, verified against the event, not against a
     later history read.
  **Whatever is chosen, write down why**, because the thing being replaced was a mechanism that looked
  plausible and guarded nothing.
- **Signature verification** if an HTTP mode is ever added (`x-slack-signature`, timestamped HMAC). Not needed
  for Socket Mode — and that is a reason to prefer Socket Mode, not an excuse to skip it later.
- **Emit, do not act.** `listen` produces classified events; it does not create tasks. The dashboard's
  `requests` table is the queue, and this repo must be usable by someone who has no dashboard at all.

### 4.3 Query / read (new — §2.9's deferred seam)

- `queryMessages({ channel, sinceMinutes | oldest, limit })` — `conversations.history`.
- `getThread({ channel, threadTs })` — `conversations.replies`.
- `search({ query })` — **user token only** (`search:read.*` are user scopes; the bot cannot search). Note that
  plainly in the docs: search is a per-person capability by Slack's construction, like as-user posting.

### 4.4 Identity and config (new)

- `slack-config.json`, per install, never shipped with real values:
  ```jsonc
  {
    "users": [ { "name": "…", "slackHandle": "@…", "slackUserId": "U…", "jiraHandle": "…" } ],
    "watchedChannels": [ { "channel": "#your-mr-channel", "purpose": "review-request" } ],
    "owner": { "slackUserId": "U…" },
    // Remote only, and two SEPARATE lists on purpose (§11.6): being allowed to post into a channel does not
    // imply being allowed to read its history. Both start empty.
    "remote": { "postableChannels": [], "readableChannels": [] }
  }
  ```
- `resolveUser(handleOrName) -> { userId, … }`, cached; `users:read`.
- **Store the Slack user ID, not just the handle.** Handles are editable by their owner; a gate keyed on a
  display name is a gate keyed on a mutable field.
- `setup` command: asks for name / Slack handle / Jira handle, resolves the user ID, writes the config. This is
  the dashboard's §14.1 requirement ("no hardcoded handles") and it belongs here because this is where the
  Slack API access is.

### 4.5 Extra features worth having (not in the dashboard's plan, cheap here)

- `doctor` — one command that reports: which tokens are present, which scopes they actually carry
  (`auth.test` + an attempted call per feature), whether Socket Mode connects, which channels the bot is in.
  **A tool whose setup can fail in eight ways needs one command that says which one.**
- `--dry-run` on every outbound path: resolve everything, format the payload, print it, send nothing. This is
  what makes the dashboard's integration testable without a workspace.
- **A recording/replay fixture mode**: capture real event envelopes once into `fixtures/`, replay them into
  `classify()` in tests. Real payload shapes are the thing you cannot guess correctly.
- **A `--json` output mode on every CLI command**, because three of the four surfaces parse the output.
- Optional: presence/status (`users.profile.set`) so a worker can show as busy. Nice, not needed; list it as a
  maybe rather than building it.

### 4.6 Human-in-the-loop ask/approve (added 2026-09-09, on request — D14)

The "AI companion in Slack" capability: a running Claude Code / OpenCode session hits a permission gate or an
ambiguous choice, DMs the question to the session's owner, and **blocks the session** until a Slack reply
resolves it.

- `core/ask.js` — `createAsk` (post the DM, record a `pending` row), `recordAnswer`/`recordAnswerByThread`
  (called by the listener when an answer arrives), `waitForAnswer` (polls the LOCAL `asks` table, not Slack),
  `pollThreadForReply` (direct-Slack-poll fallback, `question`-kind only), `ask()` (the wrapper: create + wait).
- `core/db.js` — the SQLite connection (`node:sqlite`, shared with `core/ledger.js`) that makes correlation
  possible across process boundaries: the asking process (an MCP tool call, typically short-lived) is very
  often not the process that captures the answer (the long-lived listener). Both share one DB file.
- **Two kinds, two capture ceilings:**
  - `kind: 'approval'` — Approve/Deny (or custom) buttons. **Only capturable by the Socket Mode listener**
    (`listen/socket.js`'s `app.action(/^ask_/)` handler) — Slack delivers a button click as a `block_actions`
    interactivity event, never as a message, so there is no way to poll for it. The listener MUST be running.
  - `kind: 'question'` (default) — free-text reply in the DM thread. Capturable either way: by the listener
    (`app.message`'s thread-match check, the default — D9's event-driven path), or by `captureMode: 'poll'`
    (`pollThreadForReply`, opt-in/off-able, polls `conversations.replies` directly — no listener needed, but
    only ever for `question`, never `approval`).
- MCP: `slack_ask`. CLI: `cli/ask.js`.
- **Not yet live-verified**: `kind: 'approval'` needs the Slack app's Interactivity feature enabled (Socket
  Mode carries `block_actions` automatically once Interactivity is on — no separate Request URL needed) and a
  real listener connection to test against. `kind: 'question'` with `captureMode: 'poll'` WAS live-verified
  (`cli/ask.js` sent a real DM and correctly timed out with no reply — see the session transcript). 9 unit
  tests cover the DB-correlation logic itself without touching Slack (`test/ask.test.js`).

---

## 5. Repo layout to grow into

```
core/            slack.js (one HTTP call helper), post.js, dm.js, react.js, query.js, search.js, schedule.js,
                 classify.js (pure), identity.js (incl. resolveMentions), ledger.js (idempotency),
                 db.js (shared node:sqlite connection), ask.js (human-in-the-loop ask/approve)
listen/          socket.js (Socket Mode client, Bolt) — envelope handling lives inside Bolt, no envelope.js needed
cli/             post, reply, react, update, delete, dm, query, thread, search, schedule, unschedule,
                 scheduled, ask, listen, setup, doctor, resolve-user, get-user-token
mcp/             server.js (stdio transport — no behaviour)
                 tools.local.js             (full set, 16 tools)
                 tools.remote.js            (locked-down remote set; imports NO local-only modules — §11.2)
                 http.js                    (Slackbot remote MCP binding over the optional HTTP listener)
                 schema.js                  (argument schemas, shared)
skill/           SKILL.md  (+ any helper script)
config/          slack-config.example.json, manifest.json (from yadavbot's shape)
test/            classify (table-driven), ledger, identity, envelope, dry-run e2e,
                 registry (EQUALITY on remote tool names + no user-token import — §11.2),
                 no-token-in-output (grep captured stdout/stderr for the configured token),
                 remote-limits (no customize fields; own-message edits only; two allow-lists) — §11.6
fixtures/        recorded Slack event envelopes
```

Keep `post.js` / `get-user-token.js` / `verify-dm.js` working at the repo root, or in a way that does not break
anyone already calling them. **A rename is a breaking change to a tool whose whole value is that scripts call
it.** If they move, leave thin forwarders.

---

## 6. The four surfaces, concretely

### 6.1 Direct (exists, extend)
`node cli/post.js --channel '#x' --text 'hi'`, plus `--json` and `--dry-run` everywhere. Also importable:
`import { postToChannel } from './core/post.js'`.

### 6.2 Dashboard (`slack-message` utility agent)
The dashboard already has the authorization model for this and it constrains what to expose:

- Its capability vocabulary already contains **`slack:post-bot`** and **`slack:post-as-user`**, and the
  `utility:slack` preset holds only `read:registry` + `slack:post-bot`. **As-user posting is deliberately NOT in
  the preset**, because it is in the dashboard's **sensitive class**: it needs a second principal's approval
  bound to the exact arguments, single-use and expiring.
- So this repo must make the two paths **separately callable** — never one function with a boolean that a
  caller can flip. A capability that cannot be granted separately cannot be gated separately.
- The dashboard's agent is a thin caller. Everything it needs must be reachable with a structured result
  (`--json`) and a non-zero exit on failure.

### 6.3 MCP server (two profiles, one core)

**Local (stdio) = the full tool set. Remote (Streamable HTTP) = channel posting only, by omission (§11.2).**
`mcp/tools.local.js` and `mcp/tools.remote.js` are separate registries; the HTTP binding may only be built with
the remote one, and it does not import `postAsUser`, `dm`, `search` or the listener at all.

- **stdio transport.** One hard rule: **nothing may write to stdout except MCP protocol frames.** A stray
  `console.log` in a core function corrupts the stream, which is a second reason §0 forbids logging in core.
  Logs go to stderr.
- Tools, one per core function, names matching the CLI: `slack_post`, `slack_dm`, `slack_reply`, `slack_react`,
  `slack_query_messages`, `slack_get_thread`, `slack_doctor`.
- **`slack_post_as_user` is a separate tool**, absent unless a user token is configured — same reason as §6.2,
  and **absent from the remote registry entirely** regardless of configuration (§11.2).
- Every tool's schema declares its required arguments, and a missing one is **rejected, not guessed**. (The
  dashboard calls this "never guess an underspecified task"; it applies with more force to a tool a model calls
  unattended.)
- Usage is "pull the repo, point a client at it":
  ```jsonc
  { "mcpServers": { "team-slack-bridge": { "command": "node", "args": ["/abs/path/team-slack-bridge/mcp/server.js"] } } }
  ```
- Document that the server reads `.env` and `slack-config.json` **from the repo directory**, so one clone is one
  install with one identity — which is exactly the existing design principle, restated for a new surface.

### 6.4 Skill
- `skill/SKILL.md` with a name, a one-line description, and a trigger (e.g. `/slack-post`).
- The skill **shells out to the CLI**; it does not re-implement anything. Its whole content is: when to use it,
  the exact commands, and what the JSON output means.
- Say in the skill when NOT to use it — as-user posting, and anything the dashboard should route through its
  own gated agent instead.

---

## 7. Constraints to hold

- **Zero dependencies today. Every addition needs a written reason.** `fetch` is built in; a WebSocket for
  Socket Mode may not be. Measure before adding: if Node's built-in `WebSocket` (available in modern Node)
  suffices, that is zero. Bolt is the one candidate worth a real decision (§3), and if it wins, the reason goes
  in this file.
- **Secrets never leave the install.** No token in a log, an error message, a journal row, a JSON result, or a
  test fixture. A `doctor` command must print *whether* a token is present and never its value.
- **Scope minimalism.** Each feature lists the scope it needs; nothing requests a scope for a feature that is
  not built. `im:read`/`im:history` in particular are a real privacy grant — the README already says so, and a
  user token that can read a person's DMs is materially bigger than everything else here.
- **Every failure is structured.** `{ ok: false, error, retryable }`, not a thrown string. The dashboard's
  outbox needs to tell "retry" from "never".
- **Test the classifier as a table.** The two gates and the trigger words are the parts most likely to be got
  subtly wrong, and they need no network to test.
- **The remote profile cannot be widened by configuration.** A capability reachable on a hosted instance must
  be reachable in `tools.remote.js`'s import graph; if it is not there, no flag, env var or request may summon
  it. The equality test in §11.2 is what keeps that true as tools are added.
- **Nothing is committed or pushed from this session.** (And a general note for this machine: two GitHub
  accounts are logged in; `anchor-mani` is active. Check `gh auth status` before any push, whenever that
  happens.)

---

## 8. Build order

Each step ends with something demonstrable. Do not start the next one until the current one runs.

1. **[DONE 2026-09-09] Extract `core/` from the existing scripts** and keep the CLIs working via thin wrappers.
   Add `--json` and `--dry-run`. Add `doctor`. *Gate met: `node cli/doctor.js --json` ran against real bot +
   user tokens (auth.test on both, no token value in output).* `core/{slack,ledger,identity,post,dm,query,
   classify,doctor}.js`, `cli/{post,reply,react,update,delete,dm,query,thread,search,doctor,setup,
   resolve-user}.js` + `cli/lib/args.js` + `cli/context.js`. Root `post.js` rewritten as a forwarder into
   `core/post.js` / `core/dm.js` — old `--text`/`--channel`/`--dm`/`--as-user` usage unchanged, `--dry-run`/
   `--json`/`--thread-ts`/`--idempotency-key` added. `get-user-token.js`/`verify-dm.js` untouched.
2. **[DONE 2026-09-09] Idempotency ledger + rate-limit handling** on the outbound paths. *Gate met:
   `test/ledger.test.js` — claim/complete/findByTs, including the "pending claim refuses a second claim"
   case; `core/slack.js` retries a 429 up to `maxRetries` honouring `Retry-After`, then returns
   `{ retryable: true }` rather than throwing.*
3. **[DONE 2026-09-09, grown since] MCP server** over the same core. *Gate met: hand-verified over stdio —
   `initialize` → `tools/list` → `tools/call` on `slack_post` with `dryRun: true` — round-tripped correctly;
   captured stdout contained only JSON-RPC frames, the startup banner went to stderr.* Tool count grew from 12
   to **16** as §4.1/§4.6 added `slack_schedule_message`/`slack_delete_scheduled_message`/
   `slack_list_scheduled_messages`/`slack_ask`; re-verified at 16 after each addition, same method.
   `mcp/{schema,tools.local,server}.js`, stdio transport, hand-rolled JSON-RPC (no dependency — see the note
   in `mcp/server.js` on why). Remote Slackbot MCP later moved to its own registry and HTTP binding per D20.
4. **[DONE 2026-09-09] Skill**, shelling out to the CLI. `skill/SKILL.md`. *Gate: invoke by name in a fresh
   Claude Code session and confirm it posts and parses JSON back — not yet exercised end-to-end, only written.*
5. **[DONE 2026-09-09] `classify()` as a pure function** with the fixture table — before any listener exists.
   `core/classify.js`, `test/classify.test.js`. *Gate met: 11 cases including the required "extras" negative
   case, both self-DM gates, all four trigger words case-insensitively, and the unwatched-channel/
   unrecognized-event/null-event ignore paths — all passing (`node --test test/`).*

6. **[BUILT, NOT LIVE-VERIFIED 2026-09-09] Socket Mode listener** feeding `classify`, per D8/D9.
   `listen/socket.js` (`createListener({ botToken, appToken, config, onClassified, onError })`, Bolt-backed,
   library-only — takes no ambient state, emits classified events, never acts on them) + `cli/listen.js`
   (thin process wrapper, prints one JSON line per classified event to stdout, SIGINT/SIGTERM-safe shutdown).
   `SLACK_APP_TOKEN` added to `.env.example`. *Gate NOT yet met: needs a real app-level token and a live
   workspace — a real DM and a real channel mention classified correctly, acked once, not redelivered. Module
   loads and Bolt's `App` constructs cleanly (`node --check`, a smoke import); that's all that's verified.*
7. **[DONE 2026-09-09] The DM-reading gate** (§4.2), per D13. `core/classify.js` now checks
   `event.user === config.owner.slackUserId` (self-dm/self-dm-start-now, trigger words apply) OR
   `config.dmAllowlist.includes(event.user)` (dm-request, trigger words never apply, per §2.4's closing rule)
   else ignores with a named reason. `cli/setup.js dm-allow --user <id>` manages the list. *Gate met as a pure
   function — 12 classify test cases pass, including the allow-list case; the "refusal is recorded, not
   dropped" half of the original gate is the listener's job (step 6) once that's live.*
8. **Query/read methods** — the functions and CLI/MCP wiring already exist (`core/query.js`, `core/search.js`,
   `cli/{query,thread,search}.js`, `mcp/tools.local.js`, done in step 1/3). *Gate NOT yet met: needs a live
   `getThread` against a real thread in a real workspace; `search`'s "clear message with only a bot token"
   path IS verified (`core/search.js` returns `{ ok:false, error:'search-requires-user-token' }` before ever
   calling Slack).*
9. **[BLOCKED — cross-repo]** Dashboard integration. Needs `custom-team-dashboard`'s `slack-message` agent and
   D12's `{channel, thread_ts}` schema fix, both out of this repo's scope.
10–13. **[PARTIALLY BUILT, NOT LIVE-VERIFIED 2026-09-10]** Registry split (`mcp/tools.remote.js`) and the
   Slackbot `/mcp` HTTP binding exist behind `slackbotMcp.enabled:false`. Remote risky tools are absent by
   import path per D20, `/mcp` always requires a valid Slack signature when enabled, actionable tools require
   Slack identity auth metadata, and channel access is restricted by `remote.postableChannels` /
   `remote.readableChannels`. Still not production-hosted or live Slackbot-verified.
14. **[BUILT, PARTIALLY LIVE-VERIFIED 2026-09-09] Human-in-the-loop ask/approve** — per D14, §4.6.
    `core/{db,ask}.js`, `listen/socket.js`'s `app.action`/thread-match additions, `cli/ask.js`, MCP's
    `slack_ask`. *Gate: `kind:'question'` + `captureMode:'poll'` live-verified — a real DM sent, correctly
    timed out with a structured `{ok:false, error:'timeout', retryable:true}` after 10s with no reply.
    `kind:'approval'` (buttons) NOT live-verified — needs Interactivity enabled on the Slack app and the
    listener (step 6, itself not live-verified) actually running.* 9 unit tests
    (`test/ask.test.js`) cover the DB-correlation logic (claim/answer/timeout/redelivery-safety) without
    touching Slack.

Two features were also added to **step 1's scope** after the fact, on request rather than per the original
plan — both `[DONE 2026-09-09]`, both covered by tests, neither needing a new dependency:
- **`resolveMentions`** (§4.1, `core/identity.js`) — live-verified: edited the real posted MR message in
  `#encore-merge-requests` to turn `@PJ @PK` into real `<@U…>` tags, confirmed via the returned message
  payload's `blocks[].elements[].type: 'user'` entries.
- **`scheduleMessage`/`deleteScheduledMessage`/`listScheduledMessages`** (§4.1, `core/schedule.js`) —
  dry-run-verified only; not yet scheduled for real (would need to wait out the actual delay to confirm
  delivery).

## 9a. Dependencies this repo now carries (D7's ledger)

| Dependency | Added | Written reason (D7) |
|---|---|---|
| `@slack/bolt` | 2026-09-09 | D8 — Socket Mode envelope/ack/redelivery semantics; see §3's "measure first" note |
| `node:sqlite` (Node built-in, not an npm package) | 2026-09-09 | D10/D11 — ledger concurrency once the listener can post alongside a CLI/MCP/dashboard call; reused by D14's ask/approve correlation table with no additional dependency |
| `@slack/web-api` | 2026-09-09 (backfilled) | D16 — retry/rate-limit handling and correct request encoding, replacing the hand-rolled `fetch` wrapper; see D16 |

### 9b. Additions since the last full pass, not yet given their own numbered section (2026-09-09)

Caught up here rather than as new top-level sections, since each is small and self-contained:

- **`core/progress.js` + `cli/progress.js` + `slack_progress_{start,update,finish}`** — a start/update/finish
  status message that edits itself in place (`postToChannel` then repeated `updateMessage` calls), for a
  long-running agent task to report progress without spamming a channel with new messages each time.
- **`mcp/validation.js`** — the MCP server now validates `tools/call` arguments against each tool's
  `inputSchema` (missing required, unknown property with `additionalProperties:false`, wrong type, bad enum)
  BEFORE the handler runs. Closes §6.3's "a missing required argument is rejected, not guessed" for real —
  previously the schemas existed but nothing enforced them at the protocol boundary.
- **`core/db.js`'s `dm_channels` table** — `core/dm.js`'s `resolveDmChannel` now caches `conversations.open`
  results by Slack user ID, so repeated DMs to the same person (e.g. every `ask()` call) skip a Slack API round
  trip after the first.
- **`listen/daemon.js` + `cli/daemon.js`** — a PID-file-based supervisor (`start`/`stop`/`restart`/`status`/
  `logs`) for the listener, answering §9's open question #2 with a concrete third option beyond "its own
  process" vs "the dashboard's supervisor": a small self-contained one. `start` is idempotent, which makes
  `* * * * * cd <repo> && node cli/daemon.js start` in cron a working auto-restart-on-crash with no separate
  watchdog process.
- **`config/slack-app-manifest.template.json`** — ships with `interactivity.is_enabled: true`, which is the
  missing setup step for D14's `kind:'approval'` buttons to ever be deliverable. Follows §3's "manifest as a
  file" pattern lifted from `yadavbot`.
- **Known limitation, reduced but not eliminated**: `listen/daemon.js`'s ownership check now stores command
  metadata in `.listener.pid`, confirms the live process command before signalling it, and `restart()` refuses
  to start if `stop()` fails. Legacy numeric PID files are accepted only when `ps` confirms `cli/listen.js`.
  This is still a lightweight local supervisor, not a full process manager with reaping/exit event tracking.
- **`core/home.js` + `cli/home.js` + `slack_publish_home`** (2026-09-09, on request) — a point-wise feature
  guide published to the App Home tab via `views.publish`, so anyone who installs the app gets a summary of
  what it does without reading this README. `listen/socket.js` republishes it automatically on
  `app_home_opened`. Requires `features.app_home.home_tab_enabled: true` in the manifest (now in the
  template) and the app reinstalled with it — **not yet live-verified**, same caveat as D14's approval buttons.

**10–13 are partially built for Slackbot MCP**: registry split, equality/import-path tests, signed `/mcp`,
Slack identity auth, channel allow-lists, attribution, audit, quota, and same-principal remote ownership exist
behind default-off config. Production hosting and live Slackbot interoperability remain unverified.

---

## 9. Open questions — all answered 2026-09-09

1. ~~**Bolt or hand-rolled Socket Mode?**~~ **ANSWERED: Bolt** (D8).
2. ~~**Where does the inbound listener RUN?**~~ **ANSWERED: both** (D9) — library first, process second.
3. ~~**The idempotency ledger's storage.**~~ **ANSWERED: SQLite**, via `node:sqlite` (D10/D11).
4. ~~**Does the bridge ever need to be multi-workspace?**~~ **ANSWERED: no** (§11.4). One deployment, one bot
   install, one workspace; a second workspace is a second instance, which is cheap once no per-user credentials
   are stored. Nothing is to be designed around multi-tenancy.
5. ~~**Thread identity for review-requests.**~~ **ANSWERED: cross-repo, deferred** (D12) — the owner will
   confirm/add `{channel, thread_ts}` on `custom-team-dashboard`'s `requests` row separately; not this repo's
   schema to own.

---

## 10. Remote deployment — can the MCP server be hosted, with each person using their own credentials?

**Short answer: yes, and the transport is the easy part.** MCP defines a local transport (**stdio**) and an
HTTP one (**Streamable HTTP**, which replaced the older HTTP+SSE transport). One core can serve both: stdio for
"pull the repo and point a client at it", HTTP for "point a client at a URL". Surface #2 in §0 simply becomes
two transports over one implementation.

**The part that is not easy, and it inverts this repo's founding principle.** The README's design principle is
*"every install is local, holding its own credentials"* and *"a user token is inherently per-person and can't be
shared."* A shared hosted server holds **other people's Slack tokens**. That is not a bigger version of this
tool — it is a different product, in which you are the **custodian of credentials that can post as your
colleagues**. Say that out loud before choosing, because everything below follows from it.

### 10.1 Three deployment shapes, cheapest first

> **Superseded in part by §11.** Shapes **A** (multi-tenant token custody) and **B** (bring-your-own-token) are
> **retired**: a hosted instance accepts no user tokens at all, so there is nothing to custody and nothing to
> bring. What remains is C — and "hosted" is now C plus "anyone authorised may call it". The table is kept
> because it is the reasoning that made §11 obviously right, not because any of it is still to be built.

| | Shape | Who holds the Slack token | What "remote" buys | Real cost |
|---|---|---|---|---|
| **C** | **One instance per person** (container on Fly/Render/Cloud Run, or a home box) | that person's own instance | reachable from any client, no laptop needed | almost none — it is today's design with a different hostname |
| **B** | **Shared server, bring-your-own-token** — the caller supplies its Slack token per session/request; the server stores none | the caller | one URL to share, no token custody | weaker convenience; token now travels in requests (TLS-only, never logged) |
| **A** | **Shared multi-tenant server with a token store** — standard SaaS Slack-app shape: each person does "Add to Slack", server keeps per-user tokens | **you** | genuine one-click onboarding | a real security product — see §10.3 |

**Recommendation: build C first, design for B, and treat A as a separate decision.** C is reachable today: the
same code, an env file, a container. It gives you "works local and remote" honestly, with zero change to the
custody model. B is a small step from C if the core never reads ambient state (§0 already requires that) — the
token becomes a parameter instead of an environment read.

### 10.2 What "people auth with their separate credentials" actually means (two identities, not one)

This is the part most likely to be got wrong, and it is the README's own rule one level up.

There are **two** separate identities in a remote deployment:

1. **Who is this MCP caller?** — authentication *to your server*. MCP's authorization spec is OAuth 2.1-based
   for HTTP transports: the server acts as an OAuth **resource server**, clients discover the authorization
   server via protected-resource metadata, PKCE is required, and resource indicators bind a token to your
   server so it cannot be replayed elsewhere. (Details of that spec have been moving — check the current
   revision rather than trusting this summary. For stdio, none of it applies: credentials come from the
   environment.)
2. **Which Slack person may this caller act as?** — a *binding* from (1) to a Slack user ID.

**The binding is the security control, and it is exactly the rule already written in the README**: *naming a
person is not authorization.* Remotely it stops being advice and becomes load-bearing. Concretely:
`requestedSlackUser` must equal the Slack identity bound to the **authenticated** MCP principal, as a hard
equality — never a name from a prompt, a header the caller sets, or a field in a tool call. The dashboard
already states this rule for its own agent (§2.6); a hosted server needs the same rule with no exceptions.

**Why this matters more here than anywhere else in the project**: the caller is usually a *model*, and the input
is often *Slack messages* — which are attacker-controllable text. A shared server holding N user tokens, driven
by a model reading untrusted text, is a confused-deputy setup: "post as Manish saying X" is one prompt
injection away unless the binding refuses it structurally. Being local is currently doing a lot of security
work; hosting removes it.

### 10.3 What shape A would have required — **NOT BEING BUILT** (retired by §11)

> Kept as the cost that §11's decision avoids. Nothing in this subsection is work to do.

If a multi-tenant server is wanted, these are not optional:

- **An installation store keyed by workspace AND user** (`team_id` + `authed_user.id`), because a bot token is
  per-workspace-install and a user token is per-person. This makes open question 4 ("multi-workspace?") a
  **yes**, and it changes the schema.
- **Encryption at rest for tokens**, with a key that is not in the same place as the data, plus rotation.
- **Slack app distribution enabled** and whatever review/admin-approval that entails for installs into other
  people's workspaces; org admins may gate it.
- **Token rotation support** if enabled on the app, plus refresh handling.
- **Revocation that works**: a person must be able to disconnect and have their token deleted, and an admin
  must be able to revoke centrally.
- **Per-tenant isolation in every query.** One missing `WHERE team_id = ?` is a cross-workspace leak.
- **An audit log of every action with the principal that caused it** — the dashboard already learned to journal
  refusals as well as successes, for the same reason.
- **A story for "the server is compromised"**, since the answer is currently "every connected person's Slack
  can be posted to as them."

None of that is exotic; it is simply a different amount of work from a local tool, and it is ongoing rather than
one-off.

### 10.4 What to build now so nothing has to be undone

Do these regardless of which shape is eventually chosen, because they are all cheap now and expensive later:

1. **Keep the core credential-agnostic.** Tokens are parameters, never `process.env` reads inside core
   functions. §0 already says this; it is what makes B possible without a rewrite.
2. **One place that resolves "who is asking, and what may they act as."** A single
   `resolvePrincipal(context) -> { callerId, slackUserId, capabilities }`, called by every surface. Local stdio
   returns the install's own identity; a hosted transport returns the authenticated one. **Every surface must go
   through it** — the dashboard's own reviews found the same class of bug three times, where a correct rule was
   never consulted at the call site.
3. **Separate the two posting paths at the API level** (§6.2): `postAsBot` and `postAsUser` as distinct
   functions and distinct MCP tools. A hosted server can then expose the first and withhold the second.
4. **Never log a token, and never return one** — including in a `doctor` output or an error message. Add a test
   that greps captured output for the configured token, the way the dashboard tests that its principal tokens
   never reach a logger.
5. **Transport as a thin layer.** A transport binding (`mcp/stdio.js`, `mcp/http.js`) plus a tool registry, so
   adding Streamable HTTP is a new binding rather than a second server — and so the remote profile is a
   different REGISTRY rather than a different codebase (§11.2).

### 10.5 The question to answer before writing any hosting code — **ANSWERED (§11)**

> **Answer: only the bot's.** No hosted instance holds a user token, so the answer to "whose Slack tokens will
> the server hold" is "one bot token, which is shared infrastructure by design". Everything below is kept as the
> record of why that question was the deciding one.

**Whose Slack tokens will the server hold?** If the answer is "only mine" → shape C, nothing else changes. If it
is "each person's, so onboarding is one click" → shape A, and §10.3 is the actual scope of work. There is no
version where a shared server holds other people's user tokens and is only a transport change.

---

## 11. DECISION: the remote profile is locked down by construction (2026-09-09)

**Owner's decision.** On a remote/hosted deployment, the recommended-safe settings are **the only** settings.
Nobody operating or calling a hosted instance can turn the risky capabilities on. Anyone who wants them **forks
the repo and changes it at their own risk**, and the fork is where that risk lives.

**What is OFF on remote — everything that needs a USER token, plus every DM path:**

| Capability | Local | Remote | Why |
|---|---|---|---|
| Post to a **channel** as the bot | ✅ | ✅ | the bot is shared infrastructure by design; it never acts as a person |
| Reply in a thread, react | ✅ | ✅ | same bot token, same blast radius |
| Update / delete a message | ✅ | ✅ **own only** | scoped by the idempotency ledger to messages THIS instance posted — see §11.6 |
| **Custom `username` / `icon_*` on a post** | ✅ | ❌ | `chat:write.customize` is a visual-impersonation primitive; §11.6 |
| Read channel history / thread (`queryMessages`, `getThread`) | ✅ | ✅ **allow-listed** | bot scopes only, and behind a SEPARATE readable-channels list that is empty by default; §11.6 |
| Resolve a handle to a user ID | ✅ | ✅ **configured users only** | otherwise it is a workspace directory-enumeration primitive; §11.6 |
| `doctor` | ✅ full | ✅ **reduced** | remote reports health and the caller's permitted channels, never token presence or the scope set |
| **Post as a specific person** (`--as-user`) | ✅ | ❌ | needs a user token; hosting it means holding someone's ability to speak as themselves |
| **DM a user** / **read DMs** / self-DM triggers | ✅ | ❌ | DMs are private by default and the inbound gates assume a single local owner |
| `search` | ✅ | ❌ | Slack only offers search on a user token, so it is out automatically |
| Inbound listener (Socket Mode) + task triggers | ✅ | ❌ | it acts on a *specific* owner's intent; a shared instance has no such owner |

### 11.1 Why this is the right trade, not a limitation

**It removes token custody entirely.** §10.3's whole list — per-user token store, encryption at rest with
separate keys, rotation, per-person revocation, cross-tenant isolation, "what if the server is compromised" —
exists *only* because a shared server would hold other people's **user** tokens. Take those away and a remote
instance holds one **bot** token, which the README already establishes as shareable: *"every user of this tool
can point at the same Bot Token, since the bot always acts as 'the bot,' never as a specific person."*

So shape A stops being a security product and becomes ordinary hosting. That is a large simplification bought
with a small feature loss, and the feature that is lost is precisely the one that cannot be made safe by
hosting it.

### 11.2 "Nobody can change it" has to be structural, not a flag

A config flag that defaults to safe is changeable by whoever runs the server. That is not what was decided.

**Implement the remote profile as a separate tool registry that never imports the risky functions:**

- `mcp/tools.local.js` — the full set.
- `mcp/tools.remote.js` — channel post, thread reply, react, update/delete, channel/thread reads, configured-user
  resolution, and reduced `doctor`. **It does not import** `tools.local.js`, `postAsUser`, `dm`, `ask`,
  `search`/`core/search.js`, App Home publishing, scheduling, progress mutation, agent-session creation, or the listener. There
  is no code path from the remote transport to them, so they are unreachable by **omission**, not by a check that
  could be inverted.
- The HTTP transport binding may only be constructed with the remote registry. If someone wants otherwise, they
  edit the file — which is exactly "fork it and own the risk".

This is the same principle the dashboard settled on for its own gate: *a capability that is absent cannot be
mis-granted*, and **fail-closed by omission beats a flag that is read but not obeyed.**

**Make it a test, so it cannot drift:** assert that the remote registry's tool names are **exactly** the allowed
set — not a subset check, an equality check — and that the HTTP remote path does not import `tools.local.js`,
`core/dm.js`, `core/ask.js`, or `core/search.js`. A new tool added to the local set must therefore be a deliberate decision to
expose or withhold, and a test failure is the prompt to make it. (The dashboard's capability-coverage case works
this way, and it immediately caught two entries nobody had classified.)

Say it in three places, because a locked-down deployment that does not announce itself gets mistaken for a
broken one: the README, the server's startup banner (`profile: remote (channel-post only; fork to change)`), and
the refusal message itself — which must name the profile, not just say "not permitted".

### 11.3 What still needs securing on remote, even bot-only

Removing user tokens closes the confused-deputy hole. Four things remain, all cheap:

1. **Who may call it.** Built locally for Slackbot MCP: `/mcp` always verifies Slack's request signature when
   `slackbotMcp.enabled` is true, and actionable remote tools require `authType:"slack_identity_auth"` plus
   signed `_meta.slack` user identity. `no_auth` is accepted only for non-actionable discovery/doctor behavior.
2. **A channel allow-list.** Built locally: channel write tools check `remote.postableChannels`; channel read
   tools check `remote.readableChannels`.
3. **Attribution on every message.** Built locally for remote post/reply/update: the text carries the Slack
   caller as a visible footer.
4. **A per-caller quota.** Built locally: remote actionable calls are counted per `_meta.slack.user_id` in
   `.ledger.sqlite` with `slackbotMcp.rateLimitPerMinute` defaulting to 30.

Audit logging is built locally in the `remote_audit` SQLite table: principal, tool, channel, timestamp, and
result/error. Remaining work is live Slackbot interoperability and production deployment hardening.

### 11.4 Consequences for the earlier sections

- **§10.1's shape A is effectively retired** for this repo: a hosted instance is "shape C, but anyone may call
  it", with no per-user credentials. Shape B (bring-your-own-token) also becomes unnecessary — the token a
  caller would bring is a user token, which remote does not accept at all.
- **Open question 4 (multi-workspace?) can be answered NO** for the hosted profile: one deployment, one bot
  install, one workspace. Anyone needing a second workspace runs a second instance, which is now cheap.
- **§4.2's DM gate stays a local-only concern**, which is the right place for it — it was always about a single
  owner's intent.
- The **skill** and the **dashboard agent** are unaffected: both run locally and keep the full set. The
  dashboard's own `slack:post-as-user` remains in its sensitive class, needing a second signature — that
  restriction is now belt-and-braces rather than the only line of defence.

### 11.5 ~~One thing to decide~~ — DECIDED: leverage everything that is safe

**Owner's decision (2026-09-09): if it is safe, remote gets it.** So reads ARE available remotely — behind a
separate allow-list that starts empty, which keeps "posting is additive, reading is extraction" true without
withholding a capability that is genuinely safe when scoped. The full reasoning and the four limits that make it
safe are §11.6.

### 11.6 What remote may leverage, and the limits that make each one safe

The decision is "leverage whatever is safe", so this is the list — and each row earns its place with a limit,
not with optimism.

**First, the distinction that keeps §11.2 intact.** There are two different knobs and they must never be confused:

- **The REGISTRY decides WHAT** — which capabilities exist at all on a hosted instance. Structural, in code, not
  reachable by configuration. This is D5 and it does not bend.
- **The ALLOW-LIST decides WHERE** — which channels a capability may touch. Configuration, set by the operator,
  never by the caller.

Neither can be used to obtain the other: no allow-list entry can summon an absent tool, and no tool can widen
its own allow-list. Say this out loud in the README, because "config can't widen the profile" and "config
narrows the blast radius" sound contradictory until the two knobs are named.

**1. `chat:write.customize` is refused on remote — and this is the one hole the no-user-token decision does NOT
close.** That scope lets a `chat.postMessage` call set `username`, `icon_url` and `icon_emoji`. On a shared
instance that is **visual impersonation without a user token**: an authenticated caller could post a message
that appears, to every human reading the channel, to come from a named colleague. The remote post function
therefore **does not accept those fields at all** (they are absent from its schema, not stripped at runtime),
and the bot posts under its own name and icon, always. If a fork wants them, that fork owns the consequence.
*Worth noting how this was missed once already: removing user tokens felt like it closed the impersonation
question, and it closed only the API half of it. The visual half lives in a scope the README already requests.*

**2. Update / delete only what this instance posted.** The `ts` of every send is already recorded by §4.1's
idempotency ledger, so the remote `updateMessage`/`deleteMessage` take a ledger-known `ts` and refuse anything
else by name. Without that limit, an authenticated caller could edit or delete **any** message the shared bot
ever posted — including another caller's, and including the dashboard's own outbox deliveries. Editing history
you did not write is a bigger power than posting.

**3. Reads behind a SEPARATE `readableChannels` list, empty by default.** Being allowed to post a build
notification into a channel does not imply being allowed to read that channel's history — so remote keeps two
lists, `postableChannels` and `readableChannels`, and they are not the same field. An operator who wants read
access names the channels; until then every read is refused by name. `search` stays absent regardless, because
Slack only offers it on a user token.

**4. `resolveUser` limited to the configured `users` list.** Mentioning a colleague properly needs their user
ID, so the capability is useful. Unrestricted, it is a directory-enumeration primitive against the workspace. So
remote resolves only handles that appear in `slack-config.json`'s `users` array — the team the operator already
wrote down — and refuses anything else without saying whether it exists.

**5. A reduced `doctor`.** Locally it reports which tokens are present and which scopes they carry, which is
exactly what makes it useful for setup. Remotely that is fingerprinting for a caller who does not administer the
instance, so the hosted variant reports: profile name, connectivity, and the channels THIS caller may post to or
read. Never token presence, never the scope set. (It still never prints a token value — that rule is
unconditional, §7.)

**6. `--dry-run` everywhere, including remote.** Resolve, format, return the payload, send nothing. It is the
cheapest way for a caller to check what a tool would do, and it has no blast radius by construction.

**What remains absent on remote, unchanged:** every user-token path (`postAsUser`, `search`), every DM path
(`dm`, DM reading, the self-DM triggers), and the inbound listener. Those are absent from `tools.remote.js`'s
import graph, and that is the whole of the enforcement.

**Two tests this section owes:**

- The remote post schema **rejects** `username` / `icon_url` / `icon_emoji` — asserted as a schema-level
  refusal, so a future refactor that forwards unknown fields to Slack fails here rather than in a channel.
- `updateMessage` on a `ts` this instance never posted is refused, with the ledger empty AND with the ledger
  holding a different `ts` — two cases, because "refuses when it knows nothing" and "refuses when it knows
  something else" are different code paths.

---

## 12. Public export (D15, 2026-09-09)

A public snapshot exists at **github.com/manish96170/team-slack-bridge** — one fresh commit, no `anchor-os`-era
history, pushed from an isolated `/tmp` copy so this working directory's `.git` state (branch, uncommitted
changes, original 2-commit history under whatever remote it already had) was never touched.

**What made it in:** exactly the output of `git ls-files --cached --others --exclude-standard` run against this
directory at push time — i.e. every file `.gitignore` allows, tracked or not. **What didn't:** `.env`,
`slack-config.json` (the real one, with 38 real people's names/handles/Slack IDs — populated locally this
session, never written to this file), `node_modules/`, `.DS_Store`, `.ledger.sqlite`. Verified before push with
a grep across the copied tree for `xox[bp]-`/`xapp-`/the real team ID — the only hit was the fake token string
already in `test/doctor.test.js`.

**This is a point-in-time export, not a synced remote.** Nothing here wires this working directory to push
there automatically. Everything built in this session after the push (if any) needs a deliberate re-export —
repeat the same `git ls-files … | tar …` copy-and-review, don't just `git push` from here, since this
directory's `.git` doesn't point at that repo.

---

TODO PENDING:
1. Live-verify Slack webhooks and Slackbot MCP through a public HTTPS tunnel.
1. Revisit OpenACP / ACP once there is a concrete agent/session orchestrator to connect.
