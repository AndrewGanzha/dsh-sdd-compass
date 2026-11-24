/**
 * Project configuration: `.sdd/config.json` in the repository, merged over
 * built-in defaults. Missing or broken files fall back silently to defaults.
 */

import path from 'node:path'
import { readTextSafe } from './fsx.js'

/** Built-in defaults; every field is optional in the project file. */
export const DEFAULT_CONFIG = {
  practice: 'auto',
  change: 'auto',
  strictness: 'warn',
  staleAfterDays: 14,
  language: 'ru',
  docs: { roots: ['docs', 'openspec/specs'], maxItems: 5 },
  checks: { drift: true, archive: true, stale: true, statuses: true, trace: true },
  stats: { git: true, drift: true, cacheSeconds: 600 },
  trace: { roots: ['src', 'app', 'lib', 'tests', 'test', 'packages'], maxFiles: 800 },
}

/** Shallow-merge a nested section, keeping unknown keys out. */
function mergeSection(base, extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return { ...base }
  return { ...base, ...extra }
}

/** Normalize a parsed config over the defaults. */
export function normalizeConfig(input) {
  const raw = input && typeof input === 'object' ? input : {}
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    docs: mergeSection(DEFAULT_CONFIG.docs, raw.docs),
    checks: mergeSection(DEFAULT_CONFIG.checks, raw.checks),
    stats: mergeSection(DEFAULT_CONFIG.stats, raw.stats),
    trace: mergeSection(DEFAULT_CONFIG.trace, raw.trace),
  }
}

/**
 * Load `.sdd/config.json` for a project.
 * @param {string} root - project root.
 * @returns {Promise<{ config: any, path: string|null, error: string|null }>}
 */
export async function loadConfig(root) {
  const file = path.join(root, '.sdd', 'config.json')
  const text = await readTextSafe(file, 64 * 1024)
  if (text === null) return { config: normalizeConfig({}), path: null, error: null }
  try {
    return { config: normalizeConfig(JSON.parse(text)), path: file, error: null }
  } catch (error) {
    return { config: normalizeConfig({}), path: file, error: `Не разобран .sdd/config.json: ${error?.message ?? error}` }
  }
}

/** Serialize the effective config for `/sdd init`. */
export function configTemplate(practice = 'auto') {
  return `${JSON.stringify(
    {
      practice,
      change: 'auto',
      strictness: 'warn',
      staleAfterDays: 14,
      language: 'ru',
      docs: { roots: ['docs', 'openspec/specs'], maxItems: 5 },
      checks: { drift: true, archive: true, stale: true, statuses: true, trace: true },
      stats: { git: true, drift: true, cacheSeconds: 600 },
      trace: { roots: ['src', 'app', 'lib', 'tests', 'test', 'packages'], maxFiles: 800 },
    },
    null,
    2,
  )}\n`
}
