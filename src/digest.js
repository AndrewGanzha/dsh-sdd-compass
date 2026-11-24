/**
 * Weekly digest: what moved during the last N days, derived from git, plus the
 * current snapshot and findings. This is the payload a scheduled task asks the
 * model for via the `sdd_digest` tool.
 */

import { gitText, pathCommitRange, recentDriftFiles } from './project.js'

const DAY = 86_400_000

/** Parse `git log --name-only --pretty=format:%H` into commits and files. */
export function parseLog(output) {
  const commits = []
  let current = null
  for (const raw of String(output ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^[0-9a-f]{40}$/i.test(line)) {
      current = { id: line, files: [] }
      commits.push(current)
      continue
    }
    if (current) current.files.push(line.replace(/\\/g, '/'))
  }
  return commits
}

/**
 * Build the window digest.
 * @param {{ project: any, state: any, now?: number, days?: number, run?: Function }} input
 */
export async function buildDigest(input) {
  const { project, state } = input
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const days = Number.isFinite(input.days) ? Math.max(1, Math.min(90, input.days)) : 7
  const since = now - days * DAY
  const run = input.run ?? undefined

  const digest = {
    days,
    since: new Date(since).toISOString(),
    until: new Date(now).toISOString(),
    available: Boolean(project?.isGit),
    archived: [],
    started: [],
    codeCommits: 0,
    artifactCommits: 0,
    driftFiles: [],
    cycleMedianDays: null,
    cycleSample: 0,
    reason: project?.isGit ? null : 'проект не под git',
  }

  if (!digest.available) return digest

  const changes = (state?.changes ?? []).filter((change) => change.relDir)
  const cycles = []
  for (const change of changes) {
    const range = await pathCommitRange(project, [change.relDir], run)
    if (!range) continue
    const first = range.first * 1000
    const last = range.last * 1000
    if (change.archived && last >= since) digest.archived.push(change.id)
    if (!change.archived && first >= since) digest.started.push(change.id)
    if (change.archived && range.commits >= 2) {
      const span = (range.last - range.first) / 86400
      if (span > 0) cycles.push(span)
    }
  }

  const log = await (run ?? gitText)(project.root, [
    'log',
    `--since=${days}.days.ago`,
    '--name-only',
    '--pretty=format:%H',
  ])
  const commits = parseLog(log)
  for (const commit of commits) {
    const code = commit.files.filter((file) => !isArtifact(file))
    if (code.length > 0) digest.codeCommits += 1
    if (code.length !== commit.files.length) digest.artifactCommits += 1
  }

  const drift = await recentDriftFiles(project, days, run)
  digest.driftFiles = drift ?? []

  if (cycles.length > 0) {
    const sorted = [...cycles].sort((left, right) => left - right)
    const middle = Math.floor(sorted.length / 2)
    digest.cycleMedianDays =
      Math.round((sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]) * 10) / 10
    digest.cycleSample = cycles.length
  }

  return digest
}

/** Paths that belong to planning artifacts. */
function isArtifact(file) {
  const normalized = file.replace(/\\/g, '/')
  return (
    normalized.startsWith('openspec/') ||
    normalized.startsWith('.scratch/') ||
    normalized.startsWith('.sdd/') ||
    normalized.startsWith('docs/') ||
    normalized.startsWith('specs/')
  )
}

/**
 * Render the digest as Markdown.
 * @param {any} state
 * @param {any} digest
 */
export function digestText(state, digest) {
  const from = String(digest.since).slice(0, 10)
  const to = String(digest.until).slice(0, 10)
  const name = state?.project?.name ?? '—'
  const lines = [`# SDD-дайджест · ${name} · ${from} — ${to} (${digest.days} дн)`, '']

  lines.push('## Итог')
  if (digest.available) {
    lines.push(`- Заархивировано: ${digest.archived.length}${digest.archived.length ? ` (${digest.archived.join(', ')})` : ''}`)
    lines.push(`- Начато: ${digest.started.length}${digest.started.length ? ` (${digest.started.join(', ')})` : ''}`)
    lines.push(
      `- Цикл за окно: ${digest.cycleMedianDays !== null ? `${digest.cycleMedianDays} дн медиана (n=${digest.cycleSample})` : 'мало данных'}`,
    )
  } else {
    lines.push(`- История недоступна: ${digest.reason}`)
  }

  const snapshot = state?.stats?.snapshot
  if (snapshot) {
    lines.push(`- В работе: ${snapshot.wip}${snapshot.stuck?.length ? ` · застряло: ${snapshot.stuck.length}` : ''}`)
  }

  if (digest.available) {
    lines.push('', '## Движение')
    lines.push(`- Коммитов с кодом: ${digest.codeCommits} · с артефактами: ${digest.artifactCommits}`)
    lines.push(`- Файлов кода вне артефактов: ${digest.driftFiles.length}`)
    if (digest.driftFiles.length > 0) {
      for (const file of digest.driftFiles.slice(0, 5)) lines.push(`  - ${file}`)
    }
  }

  if (state) {
    lines.push('', '## Сейчас')
    lines.push(`- Фаза: ${state.phaseLabel}${state.change?.id ? ` · изменение "${state.change.id}"` : ''}`)
    if (state.change?.tasks?.total) lines.push(`- Задачи: ${state.change.tasks.done}/${state.change.tasks.total}`)
    if (state.next) lines.push(`- Следующий шаг: ${state.next.label}${state.next.command ? ` (${state.next.command})` : ''}`)
    if (snapshot?.stuck?.length) {
      lines.push(`- Застряло: ${snapshot.stuck.map((item) => `${item.id} (${item.days} дн)`).join(', ')}`)
    }
  }

  lines.push('', '## Замечания')
  if (!state?.findings?.length) lines.push('- нет')
  else for (const finding of state.findings) lines.push(`- ${finding.severity}: ${finding.message}`)

  return lines.join('\n')
}
