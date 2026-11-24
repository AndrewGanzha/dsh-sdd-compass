/**
 * Traceability: `@sdd <token>` annotations in code link implementation back
 * to a change (OpenSpec) or to a requirement (SSC). The scanner is bounded and
 * cached; it never walks the whole repository unbounded.
 */

import path from 'node:path'
import { isDir, readTextSafe, relPath, walkFiles } from './fsx.js'

/** `@sdd FR-012`, `@sdd: change-id`, `@sdd = BR-3` */
const ANNOTATION = /@sdd(?:\s*[:=]\s*|\s+)([A-Za-z0-9][A-Za-z0-9._-]*)/g

/** File extensions worth scanning for annotations. */
const CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte',
  'py', 'cs', 'go', 'rs', 'java', 'kt', 'kts', 'php', 'rb', 'swift',
  'c', 'h', 'cc', 'cpp', 'hpp', 'scala', 'sql', 'sh', 'ps1', 'bash',
])

/** Default scan roots, checked for existence. */
const DEFAULT_ROOTS = ['src', 'app', 'lib', 'tests', 'test', 'packages', 'backend', 'frontend']

/** Cache lifetime for the annotation index. */
const TRACE_TTL_MS = 10 * 60_000

/** Parse annotation tokens from one file's text. */
export function parseAnnotations(text) {
  if (!text) return []
  const tokens = new Set()
  for (const match of text.matchAll(ANNOTATION)) tokens.add(match[1])
  return [...tokens]
}

/** True when a token looks like a stable requirement id (`FR-012`). */
export function looksLikeId(token) {
  return /^[A-Z]{1,4}-\d+$/.test(token)
}

/**
 * Collect annotations under the configured roots.
 * @param {string} root - project root.
 * @param {{ roots?: string[], maxFiles?: number }} config - `.sdd/config.json` trace section.
 * @param {Map<string, any>} [cache] - shared cache (root-keyed).
 * @returns {Promise<{ files: number, byId: Record<string, string[]>, tokens: string[] }>}
 */
export async function collectAnnotations(root, config = {}, cache) {
  const key = `trace:${root}`
  if (cache) {
    const cached = cache.get(key)
    if (cached && Date.now() - cached.at < TRACE_TTL_MS) return cached.data
  }

  const roots = Array.isArray(config?.roots) && config.roots.length > 0 ? config.roots : DEFAULT_ROOTS
  const maxFiles = Number.isFinite(config?.maxFiles) ? Math.max(50, Math.min(5000, config.maxFiles)) : 800

  const byId = {}
  const files = []
  let scanned = 0

  for (const scanRoot of roots) {
    const dir = path.join(root, scanRoot)
    if (!(await isDir(dir))) continue
    const candidates = await walkFiles(dir, {
      maxDepth: 8,
      maxFiles: Math.max(50, maxFiles - scanned),
      filter: (file) => {
        const extension = file.split('.').pop()?.toLowerCase() ?? ''
        return CODE_EXTENSIONS.has(extension)
      },
    })
    for (const file of candidates) {
      scanned += 1
      const text = await readTextSafe(file, 256 * 1024)
      const tokens = parseAnnotations(text)
      if (tokens.length === 0) continue
      const rel = relPath(root, file)
      files.push(rel)
      for (const token of tokens) {
        byId[token] ??= []
        if (byId[token].length < 20) byId[token].push(rel)
      }
    }
  }

  const data = { files: files.length, scanned, byId, tokens: Object.keys(byId) }
  cache?.set(key, { at: Date.now(), data })
  return data
}

/** Files from `changedFiles` that carry any annotation. */
export function annotatedChangedFiles(trace, changedFiles) {
  if (!trace || !Array.isArray(changedFiles)) return []
  const annotated = new Set(Object.values(trace.byId).flat())
  return changedFiles.filter((file) => annotated.has(file))
}
