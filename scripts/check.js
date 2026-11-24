/**
 * CLI probe: print the computed SDD state for a project without the GUI.
 *
 *   node scripts/check.js <path> [--json] [--prompt]
 */

import { resolveProject } from '../src/project.js'
import { buildState } from '../src/state.js'
import { promptText, statsText, statusText } from '../src/render.js'

const args = process.argv.slice(2)
const target = args.find((value) => !value.startsWith('--')) ?? process.cwd()
const asJson = args.includes('--json')
const showPrompt = args.includes('--prompt')
const showStats = args.includes('--stats')

const project = await resolveProject(target)
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
  console.log(`\ncomputed at ${state.computedAt}; root ${state.project.root}`)
}
