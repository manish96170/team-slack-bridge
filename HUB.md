# Hub: delegated sessions (PLAN D74)

"Start a session on someone else's machine", approved by that machine's owner.
Opt-in. Off by default. Nothing here changes how a session on your own machine works.

## The idea

- You message the shared Slack app: `start session on Daniel Reed: fix the login bug`.
- The **hub** checks who you are (Slack asserts your user id), whether you are blocked,
  and whether Daniel has granted you that repo.
- If there is no grant, Daniel gets a card in his own DM with the bot: **Allow always /
  Allow once / Deny**, or he can reply in the thread with repos (`api, web`), `all`, or `no`.
- Once approved, the session runs on **Daniel's machine**. The thread lives in **your** DM,
  so you see everything you sent and everything it answered.
- Daniel keeps a control card: **Stop / Restart / Block user**.

Starting a session on your own machine is unchanged: `start session <task>`.

The two setups, with flow diagrams, are in the README section *Delegated sessions*.

## Syntax

| You type | Meaning |
|---|---|
| `start session on Daniel Reed: <task>` | delegate; the colon ends the name |
| `start session - Daniel Reed: <task>` | same |
| `start session on <@U123ABC> <task>` | by mention (no ambiguity) |
| `start session --on "Daniel Reed" <task>` | quoted name |
| `... --repo api --backend claude --model x` | same flags as always, after the colon |

A bare `on <words>:` that matches nobody is treated as an ordinary task, so a task like
`on the login page: fix the spacing` still starts locally. The explicit forms (mention,
quotes, `--on`, leading dash) report an error instead of guessing.

## Owner controls

In the control card thread (bare words): `stop`, `restart`, `block`.
Anywhere in your own DM with the bot (prefix `hub`):

```
hub grants
hub grant @user repo=api,web [level=always|ask|readonly] [expires=7d]
hub revoke @user [repo=api,web]
hub block @user
hub unblock @user
```

At the machine: `tsb-hub status|grants|grant|revoke|block|unblock|resign`.

## What a grant means

- **Per repo.** A grant for `api` never covers `web`; a request for a new repo asks again.
- **Level** (changed live, even mid-session):
  - `always`: the agent's actions run without per-step prompts. This is the default.
  - `ask`: the owner approves each step in their own DM.
  - `readonly`: read/search/fetch only; anything else is rejected.
- **Never allow_always.** Even at `always` the bridge only ever selects a one-shot allow, so
  an agent cannot make its backend remember a blanket permission.

## Limits that apply even at `always`

1. The policy file, its key and the config are denied to the agent: file access refuses
   them even when a repo is registered above the home directory, and terminal commands run
   under a sandbox (macOS `sandbox-exec`) that denies the bridge's home directory.
2. Terminal commands get a scrubbed environment: no `SLACK_*`/`TSB_*` ever; delegated
   sessions also lose anything token/secret/password/key shaped and AWS credentials.
3. Only the owner's Slack id changes a grant. A requester can never raise their own access.
4. Block stops all of the requester's running delegated sessions and refuses their next message; revoke stops those on the revoked repos. A command already running inside the agent's own tools may finish.
5. Every grant change is appended to the signed policy's audit list.

## What this does NOT protect against (read this)

- **Delegated sessions use their own sandboxed backend process** (D76), so the agent's built-in
  tools cannot read the bridge's home directory either. That backend still holds your model
  credentials (it needs them) and runs as your OS user; `sandbox-exec` is the only barrier,
  it is deprecated, and it does not exist off macOS. For stronger isolation run delegated
  sessions under a separate OS user, container or VM. Treat approving a session as granting
  that agent real access to the repo you chose.
- The network hub serves ONE Slack workspace; host tokens and thread routes are keyed by user
  id and channel, not workspace. A host can only bind a thread the hub just forwarded to it.


- The sandbox covers commands the **bridge** runs for the agent (ACP `terminal/*`). If an
  agent backend runs its own tools outside those handlers, that code is not sandboxed.
  Verify your backend routes shell and file access through the client before relying on it.
- Policy signing is tamper-**evidence**. The same OS user could re-sign the file; the
  sandbox is what stops an agent from doing so. Where `sandbox-exec` is unavailable
  (non-macOS), only the signature and environment scrub apply.
- The key is in the macOS Keychain when possible, else a `0600` file in the home directory.
  `tsb-hub status` shows which.
- `sandbox-exec` is deprecated by Apple but still works. `hub.delegatedSandbox: "off"`
  disables it.
- Slack splits events across every Socket Mode connection of one app. Run **one** hub per
  app, or events reach the wrong machine.

## Config

```json
"hub": { "enabled": true, "mode": "embedded", "defaultGrantLevel": "always",
         "approvalTimeoutSeconds": 600, "delegatedSandbox": "auto" }
```

Needs `owner.slackUserId` and `agentSessions.enabled`. Enable the **Messages tab** in the
Slack app (the manifest template now sets it) so people can DM the bot.

## Shapes

- **Embedded:** the hub runs inside the owner's listener; this process is the host.
- **Network hub:** `tsb-hub-server start` holds the shared app's single Socket Mode connection
  and forwards each event to the right person's machine; each developer runs
  `tsb-hub-connect --url <hub> --token <host token>`. Hosts dial OUT (a long-lived HTTP
  stream, no inbound port, no extra dependency). Routing: a start goes to the target's host
  (`on <person>`) or the sender's own; a thread reply goes to the host that reported the
  session; a button click or owner DM goes to that person's host. An offline target gets an
  immediate reply and nothing is queued.
  - Policy, grants, approval cards and the sandbox stay on the OWNER's host, the same code as
    embedded mode. The hub holds no policy and runs no agent.
  - Hosts still need `SLACK_BOT_TOKEN` to post session output. Terminal commands never see it.
  - `tsb-hub-server add-host <U…>` prints a host token once (only its hash is stored).
  - Use TLS in front of the hub beyond localhost; the connector refuses plain http elsewhere
    unless `--insecure`.
  - Not supported over the network yet: slash commands and the message shortcut.
- **Per-developer apps stay supported:** each person can run their own app with an embedded
  hub; nothing requires a shared app.

## Multi-account listeners (D75)

- `node cli/daemon.js start --all` runs ONE supervisor with one Socket
  Mode connection per account that has a bot token, app token and owner. `--account <name>`
  runs one account; no flag keeps the old default-account behaviour.
- **The same Slack app installed in several workspaces** (one OAuth client id, one app token,
  a bot token per workspace) is served over ONE shared Socket Mode connection. An account
  with no app token of its own borrows the one from an account with the same client id.
  Events are routed to the right account by workspace id and never to another account.
  Each account keeps its own tokens, database, sessions and hub.
- Accounts with no usable app token at all are skipped with the reason logged.
- Pid and log files live in `<TSB_HOME>/run/<name>/`, not in the package folder.
  `daemon status` lists every listener. An `--all` supervisor and a single-account listener
  refuse to run together.
- Session state, backend agent processes and worktrees are scoped per account.
- `"listen": false` on an account's entry in `accounts.json` opts it out.

## Limits (D75)

`agentSessions`: `maxConcurrentSessions` (10), `maxSessionsPerUser` (3, owner exempt),
`idleTimeoutMinutes` (120; an idle agent is released and resumes on the next reply),
`worktrees` (`off|delegated|all`, default `delegated`). 0 disables a limit.
A delegated session gets its own git worktree under `<home>/worktrees/` and never falls back
to the owner's real checkout; closing removes the worktree only if it holds no changes.

`node cli/doctor.js` reports per-account listener readiness, skipped accounts, and hub setup.

## Not built

Slash commands and message shortcuts over the network hub; moving policy off the owner's machine; WebSocket transport (HTTP streaming is used instead).
