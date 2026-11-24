/**
 * Statistics: a snapshot computed from the current state plus history derived
 * from git (cycle time, drift), so the plugin never needs its own database.
 */

import { pathCommitRange, recentDriftFiles } from './project.js'

const DAY = 86_400_000

/** Median of a numeric sample (0 for an empty sample). */
export function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/** Nearest-rank percentile over an unsorted sample. */
export function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index]
}

/**
 * Build the statistics block.
 * @param {{ project: any, practice: string, change: any, changes: any[], config: any, now: number, cache?: Map<string, any> }} input
 */
export async function buildStats(input) {
  const { project, practice, change, changes, config, now, cache } = input
  const staleAfterDays = Number.isFinite(config?.staleAfterDays) ? config.staleAfterDays : 14

  const active = changes.filter((item) => !item.archived)
  const stuck = active
    .filter((item) => item.updatedAt && (now - item.updatedAt) / DAY > staleAfterDays)
    .map((item) => ({
      id: item.id,
      phase: item.phase,
      days: Math.floor((now - item.updatedAt) / DAY),
    }))
    .sort((left, right) => right.days - left.days)
    .slice(0, 5)

  const snapshot = {
    phase: change?.phase ?? 'idle',
    daysInPhase: change?.updatedAt ? Math.floor((now - change.updatedAt) / DAY) : null,
    wip: active.length,
    stuck,
    tasks: change?.tasks ?? { done: 0, total: 0 },
    questions: change?.questions ?? null,
    changes: changes.length,
  }

  const history = {
    available: false,
    reason: project.isGit ? null : 'проект не под git',
    sample: 0,
    cycleMedianDays: null,
    cycleP90Days: null,
    archiveRate: null,
    drift7d: null,
    driftPaths: [],
  }

  if (!project.isGit) return { snapshot, history }

  const statsConfig = config?.stats ?? {}
  const gitEnabled = statsConfig.git !== false
  const driftEnabled = statsConfig.drift !== false
  const ttl = Number.isFinite(statsConfig.cacheSeconds) ? statsConfig.cacheSeconds * 1000 : 10 * 60_000
  const cached = cache?.get(project.root)
  if (cached && now - cached.at < ttl) {
    return { snapshot, history: { ...cached.history } }
  }

  const nextHistory = { ...history }

  if (gitEnabled && practice === 'openspec') {
    const archived = changes
      .filter((item) => item.archived && item.relDir)
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, 8)

    const cycles = []
    for (const item of archived) {
      const range = await pathCommitRange(project, [item.relDir])
      if (!range || range.commits < 2) continue
      const days = (range.last - range.first) / DAY
      if (days > 0) cycles.push(days)
    }

    const complete = changes.filter(
      (item) => item.has.tasks && item.tasks.total > 0 && item.tasks.done === item.tasks.total,
    )
    const archivedCount = archived.length

    nextHistory.available = cycles.length > 0 || archivedCount > 0
    nextHistory.sample = cycles.length
    nextHistory.cycleMedianDays = cycles.length > 0 ? round1(median(cycles)) : null
    nextHistory.cycleP90Days = cycles.length > 0 ? round1(percentile(cycles, 90)) : null
    nextHistory.archiveRate = complete.length > 0 ? round2(archivedCount / complete.length) : null
    nextHistory.archivedCount = archivedCount
  }

  if (driftEnabled) {
    const drift = await recentDriftFiles(project, 7)
    if (drift !== null) {
      nextHistory.drift7d = drift.length
      nextHistory.driftPaths = drift.slice(0, 8)
      nextHistory.available = true
    }
  }

  cache?.set(project.root, { at: now, history: nextHistory })
  return { snapshot, history: nextHistory }
}

function round1(value) {
  return Math.round(value * 10) / 10
}

function round2(value) {
  return Math.round(value * 100) / 100
}
