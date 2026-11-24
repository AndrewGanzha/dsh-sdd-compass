/**
 * Scratch adapter: reads the matpocock-style `.scratch/<feature>/` layout —
 * `spec.md` plus `issues/NN-*.md` tickets carrying a `**Status:**` line.
 */

import path from 'node:path'
import { countCheckboxes, countQuestions, firstHeading, isDir, listDir, mtimeMs, readTextSafe, relPath } from '../fsx.js'

/** Status vocabulary of the scratch flow. */
const DONE = new Set(['done', 'completed', 'closed', 'wontfix', 'wont-fix'])
const ACTIVE = new Set(['in-progress', 'in_progress', 'review', 'in-review', 'blocked', 'needs-review'])

/** Parse the ticket's `**Status:**` value, lowercased, or null. */
export function parseTicketStatus(text) {
  if (!text) return null
  const match = text.match(/^\s{0,3}(?:[-*]\s*)?\*\*Status:\*\*\s*([^\s*]+)/im)
  return match ? match[1].trim().toLowerCase() : null
}

/** Parse the ticket's `**Blocked by:**` value, or null. */
export function parseBlockedBy(text) {
  if (!text) return null
  const match = text.match(/^\s{0,3}(?:[-*]\s*)?\*\*Blocked by:\*\*\s*(.+)$/im)
  const value = match ? match[1].trim() : ''
  return value && value.toLowerCase() !== '—' && value.toLowerCase() !== 'none' ? value : null
}

/** Prefer a meaningful spec heading; ignore generic template titles. */
function featureTitle(spec, id) {
  const heading = firstHeading(spec)
  if (heading) {
    const named = heading.match(/^(?:feature|change|spec)\s*:\s*(.+)$/i)
    if (named) return named[1].trim()
    if (!/^(feature|spec|specification)$/i.test(heading.trim())) return heading
  }
  return id
}

/** Read one scratch feature directory. */
async function readFeature(root, dir) {
  const id = path.basename(dir)
  const specPath = path.join(dir, 'spec.md')
  const spec = await readTextSafe(specPath)

  const issuesDir = path.join(dir, 'issues')
  const issueEntries = (await isDir(issuesDir)) ? await listDir(issuesDir) : []
  const issueFiles = issueEntries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => path.join(issuesDir, entry.name))
    .sort()

  const issues = []
  for (const file of issueFiles) {
    const text = await readTextSafe(file)
    const status = parseTicketStatus(text) ?? 'unknown'
    const labels = Object.fromEntries(
      [...(text ?? '').matchAll(/^\s{0,3}(?:[-*]\s*)?\*\*(Status|Blocked by|What to build):\*\*\s*(.+)$/gim)].map((match) => [
        match[1].toLowerCase(),
        match[2].trim(),
      ]),
    )
    issues.push({
      id: path.basename(file, '.md'),
      path: relPath(root, file),
      status,
      blockedBy: parseBlockedBy(text),
      checkboxes: countCheckboxes(text),
      title: firstHeading(text) ?? path.basename(file, '.md'),
      labels,
      updatedAt: await mtimeMs(file),
    })
  }

  let done = 0
  let active = 0
  let pending = 0
  let unknown = 0
  for (const issue of issues) {
    if (DONE.has(issue.status)) done += 1
    else if (ACTIVE.has(issue.status)) active += 1
    else if (issue.status === 'unknown') unknown += 1
    else pending += 1
  }

  const stamps = [await mtimeMs(specPath), ...issues.map((issue) => issue.updatedAt)]
  const updatedAt = Math.max(0, ...stamps)

  return {
    id,
    title: featureTitle(spec, id),
    practice: 'scratch',
    dir,
    relDir: relPath(root, dir),
    archived: false,
    has: {
      spec: spec !== null,
      issues: issues.length > 0,
    },
    tasks: { done, total: issues.length, active, pending, unknown },
    questions: { total: countQuestions(spec) },
    issues,
    createdAt: updatedAt || null,
    updatedAt,
    documents: [spec !== null ? relPath(root, specPath) : null, ...issues.map((issue) => issue.path)].filter(Boolean),
    artifacts: [
      { id: 'spec', path: relPath(root, specPath), state: spec !== null ? 'done' : 'missing' },
      { id: 'issues', path: relPath(root, issuesDir), state: issues.length > 0 ? 'done' : 'missing' },
    ],
  }
}

/**
 * Read every scratch feature.
 * @param {string} root - project root.
 * @returns {Promise<{ changes: any[] }>}
 */
export async function readScratch(root) {
  const scratchDir = path.join(root, '.scratch')
  if (!(await isDir(scratchDir))) return { changes: [] }

  const changes = []
  for (const entry of await listDir(scratchDir)) {
    if (!entry.isDirectory()) continue
    const dir = path.join(scratchDir, entry.name)
    const hasSpec = await readTextSafe(path.join(dir, 'spec.md'))
    const hasIssues = await isDir(path.join(dir, 'issues'))
    if (hasSpec === null && !hasIssues) continue
    changes.push(await readFeature(root, dir))
  }
  return { changes }
}
