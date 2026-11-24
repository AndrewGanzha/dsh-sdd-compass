/**
 * Project resolution: the git top level of a session's working directory,
 * its branch, its dirty-file count and the changed non-artifact files that
 * the drift checks care about.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const execFileAsync = promisify(execFile)

/** Paths that belong to planning artifacts rather than implementation. */
const ARTIFACT_PREFIXES = ['openspec/', '.scratch/', '.sdd/', 'docs/', 'specs/']

/** Hidden tooling directories that never represent implementation code. */
const TOOLING_PREFIXES = ['.omo/', '.workbench/', '.codex/', '.kilo/', '.agents/', '.claude/', '.idea/', '.vscode/', 'node_modules/']

/** File extensions that are data, not code. */
const NON_CODE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp',
  'pdf', 'docx', 'xlsx', 'pptx', 'csv',
  'zip', '7z', 'tar', 'gz', 'rar',
  'mp4', 'mp3', 'wav', 'ogg',
  'ttf', 'woff', 'woff2', 'eot',
  'lock', 'log', 'pid',
])

/**
 * Run git against a repository and return trimmed stdout, or null when git is
 * missing, the directory is not a repository, or the command times out.
 */
export async function gitText(root, args, timeout = 5000) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, ...args], {
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    })
    // Drop trailing newlines only: leading spaces are significant for
    // `git status --porcelain` (` M file` means worktree-modified).
    return stdout.replace(/\r?\n+$/, '')
  } catch {
    return null
  }
}

/** True when a workspace-relative path is a planning artifact, not code. */
export function isArtifactPath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/')
  return ARTIFACT_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))
}

/** True when a changed path is implementation code worth a drift signal. */
export function isCodePath(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/')
  if (isArtifactPath(normalized)) return false
  if (TOOLING_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) return false
  if (normalized.split('/').some((segment) => segment.startsWith('.'))) return false
  const base = normalized.split('/').pop() ?? ''
  if (!base.includes('.')) return true
  const extension = base.split('.').pop().toLowerCase()
  return !NON_CODE_EXTENSIONS.has(extension)
}

/** Parse `git status --porcelain` output into relative paths. */
export function parsePorcelain(output) {
  const files = []
  for (const line of output.split('\n')) {
    if (!line.trim()) continue
    // Two status columns followed by a path; tolerate a missing leading space.
    const raw = line.slice(2).replace(/^\s+/, '')
    // Renames are reported as "old -> new"; keep the destination.
    const target = raw.includes(' -> ') ? raw.split(' -> ').pop() : raw
    files.push(target.replace(/^"|"$/g, '').replace(/\\/g, '/'))
  }
  return files
}

/**
 * Resolve the project for a session directory.
 * @param {string} cwd - absolute session working directory.
 * @returns {Promise<{ root: string, name: string, isGit: boolean, branch: string|null, dirty: number, changedFiles: string[], codeChanges: string[] }>}
 */
export async function resolveProject(cwd) {
  const base = cwd ? path.resolve(cwd) : process.cwd()
  const top = await gitText(base, ['rev-parse', '--show-toplevel'])
  const root = top || base
  const isGit = Boolean(top)

  let branch = null
  let dirty = 0
  let changedFiles = []

  if (isGit) {
    branch = (await gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) || null
    const status = await gitText(root, ['status', '--porcelain'])
    changedFiles = status ? parsePorcelain(status) : []
    dirty = changedFiles.length
  }

  return {
    root,
    name: path.basename(root) || root,
    isGit,
    branch,
    dirty,
    changedFiles,
    codeChanges: changedFiles.filter((file) => isCodePath(file)),
  }
}

/**
 * Count unique non-artifact files touched by commits in the last `days`.
 * Bounded to the most recent 100 commits; returns null without git.
 */
export async function recentDriftFiles(project, days = 7, run = gitText) {
  if (!project.isGit) return null
  const output = await run(project.root, [
    'log',
    `--since=${days}.days.ago`,
    '--name-only',
    '--pretty=format:',
    '-n',
    '100',
  ])
  if (output === null) return null
  const files = new Set()
  for (const line of output.split('\n')) {
    const file = line.trim()
    if (!file || isArtifactPath(file)) continue
    // Commit ids can appear when a caller uses `--pretty=format:%H`.
    if (/^[0-9a-f]{40}$/i.test(file)) continue
    files.add(file)
  }
  return [...files]
}

/**
 * First and last commit timestamps that touched any of the given paths.
 * Returns null when git has no history for them.
 */
export async function pathCommitRange(project, relativePaths, run = gitText) {
  if (!project.isGit || relativePaths.length === 0) return null
  const output = await run(project.root, ['log', '--format=%ct', '--', ...relativePaths], 8000)
  if (!output) return null
  const timestamps = output
    .split('\n')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0)
  if (timestamps.length === 0) return null
  return { first: Math.min(...timestamps), last: Math.max(...timestamps), commits: timestamps.length }
}
