/**
 * Small filesystem helpers with bounded, ignore-aware traversal.
 * Every read is best-effort: a missing or unreadable path degrades to
 * null/empty instead of failing the whole state computation.
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** Directory names never worth scanning for SDD state. */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  '.pytest_cache',
  '.mypy_cache',
  'target',
  'bin',
  'obj',
])

/** Stat a path, or null when it does not exist. */
export async function statSafe(target) {
  try {
    return await fsp.stat(target)
  } catch {
    return null
  }
}

/** True when the path exists (file, directory or otherwise). */
export async function exists(target) {
  return Boolean(await statSafe(target))
}

/** True when the path exists and is a directory. */
export async function isDir(target) {
  const stats = await statSafe(target)
  return Boolean(stats?.isDirectory())
}

/** True when the path exists and is a regular file. */
export async function isFile(target) {
  const stats = await statSafe(target)
  return Boolean(stats?.isFile())
}

/** Read UTF-8 text, bounded by size; null on any failure. */
export async function readTextSafe(target, maxBytes = 512 * 1024) {
  try {
    const stats = await fsp.stat(target)
    if (!stats.isFile() || stats.size > maxBytes) return null
    return await fsp.readFile(target, 'utf8')
  } catch {
    return null
  }
}

/** Read a directory's entries; empty array on failure. */
export async function listDir(target) {
  try {
    return await fsp.readdir(target, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Modification time in milliseconds; 0 when missing. */
export async function mtimeMs(target) {
  const stats = await statSafe(target)
  return stats ? stats.mtimeMs : 0
}

/** Convert a native path to forward slashes for display and comparisons. */
export function toPosix(target) {
  return target.split(path.sep).join('/')
}

/** Workspace-relative display path. */
export function relPath(root, target) {
  return toPosix(path.relative(root, target))
}

/**
 * Depth- and count-bounded file walk that skips ignored directories.
 * @param {string} root - directory to walk.
 * @param {{ maxDepth?: number, maxFiles?: number, filter?: (file: string) => boolean }} [options]
 * @returns {Promise<string[]>} absolute file paths.
 */
export async function walkFiles(root, options = {}) {
  const { maxDepth = 4, maxFiles = 500, filter } = options
  const out = []
  async function visit(dir, depth) {
    if (out.length >= maxFiles || depth > maxDepth) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      if (IGNORED_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (filter && !filter(full)) continue
      out.push(full)
    }
  }
  await visit(root, 0)
  return out
}

/** First Markdown heading of a document, or null. */
export function firstHeading(text) {
  if (!text) return null
  const match = text.match(/^\s{0,3}#{1,3}\s+(.+?)\s*$/m)
  return match ? match[1].trim() : null
}

/**
 * Count open questions: list items under a heading that mentions questions.
 * Heuristic, but stable across the templates used by OpenSpec and SSC docs.
 */
export function countQuestions(text) {
  if (!text) return 0
  const lines = text.split('\n')
  let inSection = false
  let count = 0
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/)
    if (heading) {
      inSection = /(вопрос|question)/i.test(heading[2])
      continue
    }
    if (!inSection) continue
    if (/^\s{0,6}(?:[-*]|\d+\.)\s+\S/.test(line)) count += 1
  }
  return count
}

/** Count checked and unchecked task-list items (`- [ ]` / `- [x]`). */
export function countCheckboxes(text) {
  if (!text) return { done: 0, total: 0 }
  let done = 0
  let total = 0
  for (const line of text.split('\n')) {
    const match = line.match(/^\s{0,6}[-*]\s+\[( |x|X)\]\s/)
    if (!match) continue
    total += 1
    if (match[1] !== ' ') done += 1
  }
  return { done, total }
}
