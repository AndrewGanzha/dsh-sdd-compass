/**
 * OpenSpec adapter: reads `openspec/changes/<name>/` artifacts and the
 * archive directory. Pure filesystem parsing — no CLI spawn, so it stays fast
 * and works even when `openspec` is not on PATH.
 */

import path from 'node:path'
import { countCheckboxes, countQuestions, firstHeading, isDir, listDir, mtimeMs, readTextSafe, relPath, walkFiles } from '../fsx.js'
import { parseImpact } from '../impact.js'
import { parseTaskItems } from '../tasks.js'

/** Read the `created:` field from a change's `.openspec.yaml`. */
function parseCreated(text) {
  if (!text) return null
  const match = text.match(/^\s*created:\s*['"]?([^'"\n]+)['"]?\s*$/m)
  if (!match) return null
  const value = Date.parse(match[1].trim())
  return Number.isFinite(value) ? value : null
}

/** Prefer a meaningful heading; ignore generic template titles. */
function changeTitle(proposal, id) {
  const heading = firstHeading(proposal)
  if (heading) {
    const named = heading.match(/^change\s*:\s*(.+)$/i)
    if (named) return named[1].trim()
    if (!/^(proposal|change|spec|design|specification)$/i.test(heading.trim())) return heading
  }
  return id
}

/**
 * Parse one change directory.
 * @param {string} root - project root.
 * @param {string} dir - absolute change directory.
 * @param {boolean} archived - whether the directory sits under `archive/`.
 */
async function readChange(root, dir, archived) {
  const id = path.basename(dir)
  const proposalPath = path.join(dir, 'proposal.md')
  const designPath = path.join(dir, 'design.md')
  const tasksPath = path.join(dir, 'tasks.md')
  const metaPath = path.join(dir, '.openspec.yaml')

  const [proposal, design, tasksText, meta] = await Promise.all([
    readTextSafe(proposalPath),
    readTextSafe(designPath),
    readTextSafe(tasksPath),
    readTextSafe(metaPath),
  ])

  const specFiles = (await isDir(path.join(dir, 'specs')))
    ? (await walkFiles(path.join(dir, 'specs'), { maxDepth: 6, maxFiles: 100, filter: (file) => file.toLowerCase().endsWith('.md') }))
    : []

  const has = {
    proposal: proposal !== null,
    specs: specFiles.length > 0,
    design: design !== null,
    tasks: tasksText !== null,
  }
  const tasks = countCheckboxes(tasksText)

  const questionTexts = [proposal, design]
  for (const file of specFiles.slice(0, 3)) questionTexts.push(await readTextSafe(file))
  const questions = { total: questionTexts.reduce((sum, text) => sum + countQuestions(text), 0) }

  const artifactPaths = [proposalPath, designPath, tasksPath, metaPath, ...specFiles].filter(Boolean)
  const stamps = await Promise.all(artifactPaths.map((file) => mtimeMs(file)))
  const updatedAt = Math.max(0, ...stamps)
  const createdAt = parseCreated(meta) ?? (updatedAt || null)

  const documents = []
  if (has.proposal) documents.push(relPath(root, proposalPath))
  if (has.design) documents.push(relPath(root, designPath))
  if (has.tasks) documents.push(relPath(root, tasksPath))
  for (const file of specFiles) documents.push(relPath(root, file))

  return {
    id,
    title: changeTitle(proposal, id),
    practice: 'openspec',
    dir,
    relDir: relPath(root, dir),
    archived,
    has,
    tasks,
    taskItems: parseTaskItems(tasksText, relPath(root, tasksPath)),
    questions,
    impact: parseImpact(proposal),
    createdAt,
    updatedAt,
    documents,
    artifacts: [
      { id: 'proposal', path: relPath(root, proposalPath), state: has.proposal ? 'done' : 'missing' },
      { id: 'specs', path: specFiles.length > 0 ? relPath(root, specFiles[0]) : relPath(root, path.join(dir, 'specs')), state: has.specs ? 'done' : 'missing' },
      { id: 'design', path: relPath(root, designPath), state: has.design ? 'done' : 'missing' },
      { id: 'tasks', path: relPath(root, tasksPath), state: has.tasks ? 'done' : 'missing' },
    ],
  }
}

/**
 * Read every OpenSpec change, including archived ones.
 * @param {string} root - project root.
 * @returns {Promise<{ changes: any[], archiveDir: string, archivedCount: number }>}
 */
export async function readOpenspec(root) {
  const changesDir = path.join(root, 'openspec', 'changes')
  if (!(await isDir(changesDir))) {
    return { changes: [], archiveDir: path.join(changesDir, 'archive'), archivedCount: 0 }
  }

  const changes = []
  const entries = await listDir(changesDir)
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name === 'archive') continue
    changes.push(await readChange(root, path.join(changesDir, entry.name), false))
  }

  const archiveDir = path.join(changesDir, 'archive')
  let archivedCount = 0
  if (await isDir(archiveDir)) {
    for (const entry of await listDir(archiveDir)) {
      if (!entry.isDirectory()) continue
      archivedCount += 1
      changes.push(await readChange(root, path.join(archiveDir, entry.name), true))
    }
  }

  return { changes, archiveDir, archivedCount }
}
