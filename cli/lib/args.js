// Shared CLI argument parsing and output formatting. Every command supports
// --json (three of the four surfaces parse CLI output — §4.5) and, where it
// applies, --dry-run (§4.5).

export function parseFlags(argv, boolFlags = []) {
  const args = {}
  for (const flag of boolFlags) args[flag] = false
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (!raw.startsWith('--')) continue
    const key = raw.slice(2)
    if (boolFlags.includes(key)) {
      args[key] = true
      continue
    }
    args[key] = argv[++i]
  }
  return args
}

export function output(result, { json } = {}) {
  if (json) {
    console.log(JSON.stringify(result))
  } else if (!result.ok) {
    console.error(`Error: ${result.error}${result.retryable ? ' (retryable)' : ''}`)
  } else if (result.dryRun) {
    console.log(`[dry-run] would call ${result.request.method}: ${JSON.stringify(result.request.body ?? result.request)}`)
  } else {
    console.log('OK')
  }
  process.exitCode = result.ok ? 0 : 1
}
