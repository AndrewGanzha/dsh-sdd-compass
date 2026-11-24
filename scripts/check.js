/**
 * CLI probe and CI entry point: print the computed SDD state for a project
 * without the GUI, or fail a pipeline on findings.
 *
 *   node scripts/check.js <path> [--json] [--prompt] [--stats] [--report]
 *   node scripts/check.js <path> --ci [--fail-on warn|error|none]
 *
 * `--ci` implies `--fail-on warn`; without it the exit code is always 0.
 * `--no-git` skips project resolution through git (fixtures, non-repo dirs).
 */

import path from 'node:path'
import { shouldFail } from '../src/check.js'
import { buildDigest, digestText } from '../src/digest.js'
import { resolveProject } from '../src/project.js'
import { promptText, reportText, statsText, statusText } from '../src/render.js'
import { buildState } from '../src/state.js'

const args = process.argv.slice(2)

/** Read `--flag value` without letting the value become the target path. */
function flagValue(name) {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : null
}

const positional = []
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--fail-on' || args[index] === '--digest') {
    const next = args[index + 1]
    if (next && !next.startsWith('--')) {
      if (args[index] === '--digest' && /^\d+$/.test(next)) index += 1
      else if (args[index] === '--fail-on') index += 1
    }
    continue
  }
  if (args[index].startsWith('--')) continue
  positional.push(args[index])
}

const target = positional[0] ?? process.cwd()
const asJson = args.includes('--json')
const showPrompt = args.includes('--prompt')
const showStats = args.includes('--stats')
const showReport = args.includes('--report')
const showDigest = args.includes('--digest')
const digestArg = flagValue('--digest')
const digestDays = digestArg && /^\d+$/.test(digestArg) ? Number.parseInt(digestArg, 10) : 7
const noGit = args.includes('--no-git')
const ci = args.includes('--ci')
const failOn = flagValue('--fail-on') ?? (ci ? 'warn' : 'none')

const project = noGit
  ? {
      root: path.resolve(target),
      name: path.basename(path.resolve(target)),
      isGit: false,
      branch: null,
      dirty: 0,
      changedFiles: [],
      codeChanges: [],
    }
  : await resolveProject(target)
const state = await buildState({ root: project.root, project })

if (asJson) {
  console.log(JSON.stringify(state, null, 2))
} else {
  console.log(statusText(state))
  if (showPrompt) {
    console.log('\n--- system prompt section ---')
    console.log(promptText(state))
  }
  if (showStats) {
    console.log('\n--- stats ---')
    console.log(statsText(state))
  }
  if (showReport) {
    console.log('\n--- report ---')
    console.log(reportText(state))
  }
  if (showDigest) {
    console.log('\n--- digest ---')
    const digest = await buildDigest({ project: state.project, state, days: digestDays })
    console.log(digestText(state, digest))
  }
  console.log(`\ncomputed at ${state.computedAt}; root ${state.project.root}`)
}

if (failOn !== 'none' && shouldFail(state.findings, failOn)) {
  const worst = state.findings.filter((finding) => finding.severity !== 'info')
  console.error(`SDD check failed (--fail-on ${failOn}): ${worst.length} finding(s)`)
  for (const finding of worst) console.error(`- ${finding.severity}: ${finding.message}`)
  process.exitCode = 1
}
