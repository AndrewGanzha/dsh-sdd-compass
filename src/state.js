/**
 * State model: one practice-agnostic phase ladder computed from the artifacts,
 * plus the next action and a compact change summary.
 *
 * Phases: idle → proposal → spec → design → tasks → apply → verify → archive.
 * The plugin never invents progress: a phase is a pure function of what is
 * present on disk.
 */

import { readChanges } from './adapters/index.js'
import { runChecks } from './check.js'
import { loadConfig } from './config.js'
import { detectPractice } from './detect.js'
import { pickDocs } from './docs.js'
import { buildStats } from './stats.js'
import { annotatedChangedFiles, collectAnnotations, looksLikeId } from './trace.js'
import { matchesImpact } from './impact.js'

export const PHASES = ['idle', 'proposal', 'spec', 'design', 'tasks', 'apply', 'verify', 'archive']

const DAY = 86_400_000

/** Human labels for the dock, panel and prompt. */
export const PHASE_LABELS = {
  idle: 'нет изменений',
  proposal: 'предложение',
  spec: 'спека',
  design: 'дизайн',
  tasks: 'задачи',
  apply: 'реализация',
  verify: 'проверка',
  archive: 'завершено',
  unknown: 'неизвестно',
}

/** Next-action table, keyed by phase. */
const NEXT_ACTIONS = {
  idle: { id: 'create-change', label: 'создать изменение', hint: '/sdd init · openspec new change' },
  proposal: { id: 'write-proposal', label: 'написать proposal', hint: '/sdd docs' },
  spec: { id: 'approve-spec', label: 'согласовать спеку', hint: 'openspec instructions specs' },
  design: { id: 'write-design', label: 'написать design', hint: 'openspec instructions design' },
  tasks: { id: 'write-tasks', label: 'нарезать задачи', hint: 'openspec instructions tasks' },
  apply: { id: 'implement', label: 'реализовать задачи', hint: '/sdd next' },
  verify: { id: 'verify-archive', label: 'проверить и заархивировать', hint: '/sdd check · openspec archive' },
  archive: { id: 'done', label: 'изменение завершено', hint: '/sdd next' },
  unknown: { id: 'unknown', label: 'состояние не определено', hint: '/sdd check' },
}

/** Phase-specific rule surfaced to the model. */
const PHASE_RULES = {
  proposal: 'Код не менять до утверждённой спеки: сначала предложение.',
  spec: 'Код не менять до утверждённой спеки: правь только артефакты изменения.',
  design: 'Код не менять до утверждённого дизайна.',
  tasks: 'Сначала задачи, потом код; каждая задача — отдельный шаг.',
  apply: 'Иди по задачам, отмечай выполнение в tasks/issues.',
  verify: 'Проверь результат и заархивируй изменение; отметь проверку.',
}

/** OpenSpec phase from artifact presence and task completion. */
export function phaseForOpenspec(change) {
  if (change.archived) return 'archive'
  if (!change.has.proposal) return 'proposal'
  if (!change.has.specs) return 'spec'
  if (!change.has.design) return 'design'
  if (!change.has.tasks) return 'tasks'
  if (!change.tasks || change.tasks.total === 0) return 'tasks'
  if (change.tasks.done < change.tasks.total) return 'apply'
  return 'verify'
}

/** Scratch phase from spec presence and ticket statuses. */
export function phaseForScratch(change) {
  if (!change.has.spec) return 'spec'
  if (!change.tasks || change.tasks.total === 0) return 'tasks'
  if (change.tasks.done === change.tasks.total) return 'verify'
  if (change.tasks.done > 0 || change.tasks.active > 0) return 'apply'
  return 'tasks'
}

/** SSC phase from review state, open blockers and the workflow checkpoint. */
export function phaseForSsc(change) {
  if (!change || change.parseError) return 'unknown'
  if (change.review?.pending > 0) return 'spec'
  if (change.status === 'draft' || change.status === 'needs_review') return 'spec'
  if (change.questions?.blockers > 0) return 'spec'
  if (change.status === 'agreed') return 'verify'
  return 'spec'
}

/** Compute the phase for one change under a practice. */
export function computePhase(change, practice) {
  if (practice === 'openspec') return phaseForOpenspec(change)
  if (practice === 'scratch') return phaseForScratch(change)
  if (practice === 'ssc') return phaseForSsc(change)
  return 'unknown'
}

/** Pick the active change: explicit config first, then the freshest unfinished one. */
export function selectActive(changes, wanted) {
  if (typeof wanted === 'string' && wanted !== 'auto') {
    return changes.find((change) => change.id === wanted) ?? null
  }
  const open = changes.filter((change) => !change.archived)
  const pool = open.length > 0 ? open : changes
  if (pool.length === 0) return null
  return [...pool].sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0]
}

/** Practice-specific hint overrides for the next action. */
const PRACTICE_HINTS = {
  openspec: {
    idle: 'openspec new change',
    proposal: 'openspec instructions proposal',
    spec: 'openspec instructions specs',
    design: 'openspec instructions design',
    tasks: 'openspec instructions tasks',
    verify: '/sdd check · openspec archive',
  },
  scratch: {
    idle: 'создай .scratch/<feature>/spec.md',
    proposal: 'создай .scratch/<feature>/spec.md',
    spec: 'уточни spec.md',
    design: 'зафиксируй решения в spec.md',
    tasks: 'нарежь issues/NN-*.md',
    verify: '/sdd check',
  },
  ssc: {
    idle: 'создай model.json и brief.md',
    proposal: 'создай model.json и brief.md',
    spec: 'закрой открытые вопросы и согласуй артефакты',
    design: 'зафиксируй решения в модели',
    tasks: 'нарежь реализацию по требованиям',
    verify: 'передай на проверку или реализацию',
  },
}

/** Next action for one change. */
export function nextFor(change, practice = 'openspec') {
  const phase = change?.phase ?? 'idle'
  const action = NEXT_ACTIONS[phase] ?? NEXT_ACTIONS.unknown
  const hint = PRACTICE_HINTS[practice]?.[phase] ?? action.hint
  if (phase === 'apply' && change?.tasks) {
    return { ...action, hint, label: `реализовать задачи (${change.tasks.done}/${change.tasks.total})` }
  }
  return { ...action, hint }
}

/** Rule text for a phase, or null. */
export function ruleFor(phase) {
  return PHASE_RULES[phase] ?? null
}

/** Exact command for the next step, or null when the plugin has none. */
export function commandFor(practice, phase, changeId) {
  if (!changeId) return null
  if (practice === 'openspec') {
    if (phase === 'verify') return `openspec archive --change ${changeId}`
    if (['proposal', 'spec', 'design', 'tasks'].includes(phase)) return `openspec instructions ${phase} --change ${changeId}`
  }
  if (practice === 'scratch' && phase === 'tasks') return 'нарежь issues/NN-*.md'
  if (practice === 'ssc' && ['spec', 'design'].includes(phase)) return 'закрой блокирующие вопросы в model.json'
  return null
}

/** Compact change summary for the panel. */
export function summarize(change, now) {
  return {
    id: change.id,
    title: change.title,
    phase: change.phase,
    archived: change.archived,
    tasks: change.tasks,
    updatedDays: change.updatedAt ? Math.floor((now - change.updatedAt) / DAY) : null,
  }
}

/** Summarize the annotation index against the active change. */
function summarizeTrace(trace, requirementIds, change, project) {
  if (!trace) return null
  const has = (id) => (trace.byId[id]?.length ?? 0) > 0
  const coveredIds = requirementIds.filter((id) => has(id))
  const orphans = requirementIds.filter((id) => !has(id))
  const unknown = trace.tokens.filter(
    (token) => looksLikeId(token) && !requirementIds.includes(token) && token !== change?.id,
  )
  return {
    files: trace.files,
    scanned: trace.scanned,
    tokens: trace.tokens.length,
    linkedChange: change?.id ? (trace.byId[change.id]?.length ?? 0) : 0,
    requirementIds: requirementIds.length,
    covered: coveredIds.length,
    orphans: orphans.slice(0, 10),
    unknown: unknown.slice(0, 10),
    changedAnnotated: annotatedChangedFiles(trace, project.codeChanges ?? []).length,
  }
}

/** Map declared impact against changed and annotated files. */
function buildLinks(project, change, trace) {
  const impact = change?.impact ?? []
  const changed = project.codeChanges ?? []
  const annotated = new Set(trace ? Object.values(trace.byId).flat() : [])
  const inImpact = (file) => impact.some((entry) => matchesImpact(file, entry))
  const changedInImpact = changed.filter((file) => inImpact(file))
  const untracked = changed.filter((file) => !inImpact(file) && !annotated.has(file))
  return {
    impact: impact.length,
    changed: changed.length,
    changedInImpact: changedInImpact.length,
    untracked: untracked.slice(0, 10),
    untrackedCount: untracked.length,
  }
}

/**
 * Build the full state for one project.
 * @param {{ root: string, project: any, config?: any, now?: number, cache?: Map<string, any> }} input
 */
export async function buildState(input) {
  const { root, project } = input
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const loaded = input.config ? { config: input.config, error: null } : await loadConfig(root)
  const config = loaded.config
  const detection = await detectPractice(root, config)
  const { changes, supported, archivedCount, note } = await readChanges(root, detection.practice)

  for (const change of changes) change.phase = computePhase(change, detection.practice)
  const active = selectActive(changes, config.change)

  const stats = await buildStats({
    project,
    practice: detection.practice,
    change: active,
    changes,
    config,
    now,
    cache: input.cache,
  })

  const trace = supported ? await collectAnnotations(root, config.trace ?? {}, input.cache) : null
  const traceSummary = summarizeTrace(trace, active?.requirementIds ?? [], active, project)
  const links = buildLinks(project, active, trace)

  const findings = runChecks({
    project,
    practice: detection.practice,
    change: active,
    changes,
    config,
    now,
    driftPaths: stats.history.driftPaths ?? null,
    archivedCount,
    candidates: detection.candidates,
    trace: traceSummary,
    links,
  })

  const docs = supported ? await pickDocs({ root, project, change: active, config, now }) : []
  const phase = active?.phase ?? (supported ? 'idle' : 'unknown')
  const next = nextFor({ ...active, phase }, detection.practice)
  next.command = commandFor(detection.practice, phase, active?.id ?? null)

  const state = {
    schemaVersion: 1,
    computedAt: new Date(now).toISOString(),
    project: {
      name: project.name,
      root: project.root,
      branch: project.branch,
      dirty: project.dirty,
      isGit: project.isGit,
    },
    practice: detection.practice,
    practiceSupported: supported,
    practiceCandidates: detection.candidates,
    phase,
    phaseLabel: PHASE_LABELS[phase] ?? phase,
    rule: ruleFor(phase),
    change: active
      ? {
          id: active.id,
          title: active.title,
          relDir: active.relDir,
          archived: active.archived,
          phase: active.phase,
          artifacts: active.artifacts ?? [],
          tasks: active.tasks ?? { done: 0, total: 0 },
          questions: active.questions ?? null,
          review: active.review ?? null,
          version: active.version ?? null,
          workflow: active.workflow ?? null,
          updatedDays: active.updatedAt ? Math.floor((now - active.updatedAt) / DAY) : null,
        }
      : null,
    changes: [...changes]
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
      .slice(0, 30)
      .map((change) => summarize(change, now)),
    next,
    findings,
    docs,
    stats,
    trace: traceSummary,
    links,
    note: note ?? null,
    configError: loaded.error ?? null,
    configPath: loaded.configPath ?? null,
    strictness: config.strictness,
  }

  state.blocked = findings.some((finding) => finding.severity === 'error')
  return state
}
