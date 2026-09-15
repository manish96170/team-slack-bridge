// Named repo registry for ACP-driven agent sessions (PLAN D23). A session's
// fs/terminal access is scoped to one of these named entries — never a raw
// path typed into a Slack message — so a trigger can only reach repos an
// operator explicitly registered.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function rootHome() {
  return process.env.TSB_HOME || join(homedir(), '.team-slack-bridge')
}

export function getReposRegistryPath() {
  return join(rootHome(), 'repos.json')
}

function readRegistry() {
  const path = getReposRegistryPath()
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeRegistry(registry) {
  mkdirSync(rootHome(), { recursive: true })
  writeFileSync(getReposRegistryPath(), JSON.stringify(registry, null, 2) + '\n')
}

export function listRepos() {
  const raw = readRegistry()
  if (!raw) return { default: null, repos: {} }
  return { default: raw.default || null, repos: { ...(raw.repos || {}) } }
}

export function resolveRepoPath(name) {
  const { default: defaultName, repos } = listRepos()
  const resolvedName = name || defaultName
  if (!resolvedName) return { ok: false, error: 'no-repo-specified-and-no-default', retryable: false }
  const path = repos[resolvedName]
  if (!path) return { ok: false, error: 'repo-not-found', name: resolvedName, retryable: false }
  return { ok: true, name: resolvedName, path }
}

export function addRepo(name, path) {
  if (!name || !path) return { ok: false, error: 'name-and-path-required', retryable: false }
  if (!existsSync(path)) return { ok: false, error: 'path-does-not-exist', retryable: false }
  const registry = readRegistry() || { default: null, repos: {} }
  registry.repos = registry.repos || {}
  registry.repos[name] = path
  if (!registry.default) registry.default = name
  writeRegistry(registry)
  return { ok: true, name, path }
}

export function removeRepo(name) {
  const registry = readRegistry()
  if (!registry?.repos?.[name]) return { ok: false, error: 'repo-not-found', retryable: false }
  delete registry.repos[name]
  if (registry.default === name) registry.default = Object.keys(registry.repos)[0] || null
  writeRegistry(registry)
  return { ok: true, name }
}

export function setDefaultRepo(name) {
  const registry = readRegistry()
  if (!registry?.repos?.[name]) return { ok: false, error: 'repo-not-found', retryable: false }
  registry.default = name
  writeRegistry(registry)
  return { ok: true, name }
}
