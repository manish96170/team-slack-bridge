// `npm run build:sea` — bundles post/DM into a single Node SEA binary at
// dist/team-slack-bridge. Superseded once the repo runs as a live ACP/MCP
// server instead of a standalone binary (see PLAN.md D20 / OpenACP notes) —
// at that point this script and dist/ can go away.
//
// Repo-clone-only tool, not part of the published npm package: it bundles
// this repo's own source, and its deps (esbuild, postject) are
// devDependencies, never installed for anyone who `npm install
// team-slack-bridge`s this as a dependency rather than cloning it.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

let esbuild, inject
try {
  ;[esbuild, { inject }] = await Promise.all([import('esbuild'), import('postject')])
} catch {
  console.error('[build:sea] esbuild/postject not found — this script only works from a git clone with devDependencies installed (npm install), not from an npm-installed copy of this package.')
  process.exit(1)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..')
const DIST = join(REPO_ROOT, 'dist')
const BUNDLE_PATH = join(DIST, 'team-slack-bridge.cjs')
const BLOB_PATH = join(DIST, 'sea-prep.blob')
const SEA_CONFIG_PATH = join(DIST, 'sea-config.json')
const BINARY_NAME = process.platform === 'win32' ? 'team-slack-bridge.exe' : 'team-slack-bridge'
const BINARY_PATH = join(DIST, BINARY_NAME)
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'

// scripts/sea-entry.mjs is a hand-maintained copy of post.js (wrapped in an
// async main() since SEA's CJS main can't have top-level await). Catch drift
// between the two before it ships in a binary, not via a test that would run
// on every `npm test`.
function checkEntryParity() {
  console.log('[build:sea] checking scripts/sea-entry.mjs against post.js (dry-run parity)')
  const cases = [
    ['--text', 'parity-check', '--channel', '#parity-check', '--dry-run', '--json'],
    ['--text', 'parity-check', '--dm', 'U00000000', '--dry-run', '--json'],
  ]
  for (const args of cases) {
    const postOut = execFileSync(process.execPath, [join(REPO_ROOT, 'post.js'), ...args], { encoding: 'utf8' })
    const seaOut = execFileSync(process.execPath, [join(__dirname, 'sea-entry.mjs'), ...args], { encoding: 'utf8' })
    if (postOut !== seaOut) {
      console.error('[build:sea] post.js and scripts/sea-entry.mjs produced different output for the same args:')
      console.error(`  args: ${args.join(' ')}`)
      console.error(`  post.js:   ${postOut.trim()}`)
      console.error(`  sea-entry: ${seaOut.trim()}`)
      console.error('scripts/sea-entry.mjs has drifted from post.js — update it to match, then rebuild.')
      process.exit(1)
    }
  }
}

checkEntryParity()

mkdirSync(DIST, { recursive: true })

console.log('[build:sea] bundling scripts/sea-entry.mjs -> dist/team-slack-bridge.cjs')
await esbuild.build({
  entryPoints: [join(__dirname, 'sea-entry.mjs')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: BUNDLE_PATH,
  logLevel: 'warning',
})

writeFileSync(
  SEA_CONFIG_PATH,
  JSON.stringify(
    { main: 'team-slack-bridge.cjs', output: 'sea-prep.blob', disableExperimentalSEAWarning: true },
    null,
    2,
  ),
)

console.log('[build:sea] writing SEA preparation blob')
execFileSync(process.execPath, ['--experimental-sea-config', SEA_CONFIG_PATH], { cwd: DIST, stdio: 'inherit' })

console.log(`[build:sea] copying node runtime -> dist/${BINARY_NAME}`)
copyFileSync(process.execPath, BINARY_PATH)
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--remove-signature', BINARY_PATH], { stdio: 'inherit' })
}

console.log('[build:sea] injecting blob into binary')
await inject(BINARY_PATH, 'NODE_SEA_BLOB', readFileSync(BLOB_PATH), {
  sentinelFuse: SENTINEL_FUSE,
  machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined,
  overwrite: true,
})

if (process.platform === 'darwin') {
  execFileSync('codesign', ['--sign', '-', BINARY_PATH], { stdio: 'inherit' })
}
if (process.platform !== 'win32') {
  chmodSync(BINARY_PATH, 0o755)
}

console.log(`[build:sea] done -> dist/${BINARY_NAME}`)
