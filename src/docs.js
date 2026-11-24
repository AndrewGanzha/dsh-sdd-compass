/**
 * Documentation index: picks the few project documents worth putting in front
 * of a person or a model for the active change, with a reason for each pick.
 */

import path from 'node:path'
import { exists, mtimeMs, relPath, walkFiles } from './fsx.js'

/** Project-level documents that always matter when present. */
const PROJECT_DOCS = [
  ['AGENTS.md', 'правила проекта'],
  ['GLOSSARY.md', 'глоссарий'],
  ['README.md', 'описание проекта'],
]

/** Split an id into lowercase alphanumeric tokens worth matching on. */
export function tokens(value) {
  return [...new Set(String(value ?? '').toLowerCase().split(/[^a-z0-9а-яё]+/).filter((token) => token.length >= 3))]
}

/** Path segments that never identify a module. */
const NOISE_SEGMENTS = new Set(['src', 'app', 'lib', 'bin', 'libs', 'packages', 'tests', 'test', '__tests__', 'dist', 'build', 'index', 'main'])

/** Module tokens of the files changed in the working tree. */
export function moduleTokens(codeChanges) {
  const tokens = new Set()
  for (const file of codeChanges ?? []) {
    for (const segment of String(file).split(/[\\/]/)) {
      const clean = segment.replace(/\.[^.]+$/, '').toLowerCase()
      if (clean.length < 3 || NOISE_SEGMENTS.has(clean)) continue
      tokens.add(clean)
    }
  }
  return tokens
}

/**
 * Build and score the documentation index for one change.
 * @param {{ root: string, project?: any, change: any, config: any, now: number }} input
 * @returns {Promise<Array<{ path: string, label: string, why: string }>>}
 */
export async function pickDocs({ root, project, change, config, now }) {
  const cfg = config?.docs ?? {}
  const maxItems = Number.isFinite(cfg.maxItems) ? Math.max(1, Math.min(10, cfg.maxItems)) : 5
  const docRoots = Array.isArray(cfg.roots) && cfg.roots.length > 0 ? cfg.roots : ['docs', 'openspec/specs']
  const changeTokens = tokens(change?.id)
  const changedModules = moduleTokens(project?.codeChanges ?? [])

  const candidates = []
  const seen = new Set()
  const add = (absolute, why) => {
    const rel = relPath(root, absolute)
    if (seen.has(rel)) return
    seen.add(rel)
    candidates.push({ path: rel, absolute, why })
  }

  for (const document of change?.documents ?? []) add(path.join(root, document), 'артефакт изменения')

  for (const [name, why] of PROJECT_DOCS) {
    const absolute = path.join(root, name)
    if (await exists(absolute)) add(absolute, why)
  }

  for (const docRoot of docRoots) {
    const files = await walkFiles(path.join(root, docRoot), {
      maxDepth: 4,
      maxFiles: 200,
      filter: (file) => file.toLowerCase().endsWith('.md'),
    })
    for (const file of files) add(file, docRoot === 'openspec/specs' ? 'спека проекта' : 'документация')
  }

  const scored = []
  for (const candidate of candidates) {
    if (candidate.why === 'артефакт изменения') {
      scored.push({ ...candidate, score: 100 })
      continue
    }
    const fileTokens = tokens(candidate.path)
    const overlap = fileTokens.filter((token) => changeTokens.includes(token)).length
    const moduleOverlap = fileTokens.filter((token) => changedModules.has(token)).length
    const stats = await mtimeMs(candidate.absolute)
    const fresh = stats > 0 && now - stats < 30 * 86_400_000 ? 1 : 0
    scored.push({
      ...candidate,
      why: moduleOverlap > 0 && candidate.why === 'документация' ? 'документация изменённого модуля' : candidate.why,
      score: overlap * 5 + moduleOverlap * 4 + fresh,
    })
  }

  scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
  return scored.slice(0, maxItems).map((entry) => ({
    path: entry.path,
    label: path.basename(entry.path),
    why: entry.why,
  }))
}
