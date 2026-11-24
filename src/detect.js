/**
 * Practice detection: which SDD flavour a project uses, based on the marker
 * files that toolchain leaves behind. Detection never guesses: unknown
 * projects stay unknown and the compass stays silent for them.
 */

import path from 'node:path'
import { exists, isDir, listDir } from './fsx.js'

/** Practices this version understands. */
export const PRACTICES = ['openspec', 'scratch', 'ssc', 'generic']

/**
 * Detect the project's SDD practice.
 * @param {string} root - project root.
 * @param {{ practice?: string }} [config] - `.sdd/config.json`.
 * @returns {Promise<{ practice: string, forced: boolean, candidates: string[] }>}
 */
export async function detectPractice(root, config = {}) {
  const candidates = []

  if (await isDir(path.join(root, 'openspec', 'changes'))) {
    candidates.push('openspec')
  } else if (await exists(path.join(root, 'openspec', 'config.yaml'))) {
    candidates.push('openspec')
  }

  if (await isDir(path.join(root, '.scratch'))) {
    candidates.push('scratch')
  }

  if (await exists(path.join(root, 'model.json'))) {
    candidates.push('ssc')
  } else {
    const docsDir = path.join(root, 'docs')
    for (const entry of await listDir(docsDir)) {
      if (!entry.isDirectory()) continue
      if (await exists(path.join(docsDir, entry.name, 'model.json'))) {
        candidates.push('ssc')
        break
      }
    }
  }

  if (candidates.length === 0 && (await exists(path.join(root, 'plan.md')))) {
    candidates.push('generic')
  }

  const forced = typeof config.practice === 'string' && config.practice !== 'auto' ? config.practice : null
  if (forced) {
    return { practice: forced, forced: true, candidates }
  }
  const practice = candidates[0] ?? 'unknown'
  return { practice, forced: false, candidates }
}
