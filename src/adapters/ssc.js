/**
 * SSC adapter: reads the analyst-grade SDD/SSC canonical model — `model.json`
 * (root or `docs/<area>/model.json`) plus the versioned Markdown next to it
 * (`brief.md`, `workflow.md`, `history/`).
 *
 * The SSC model is review-centric: artifact reviews and open questions decide
 * the phase, and `workflow.md` supplies the human's own "what is next" line.
 */

import path from 'node:path'
import { exists, isDir, listDir, mtimeMs, readTextSafe, relPath, firstHeading } from '../fsx.js'

/** Find the canonical model file, if the project has one. */
export async function findModel(root) {
  const direct = path.join(root, 'model.json')
  if (await exists(direct)) return direct
  const docsDir = path.join(root, 'docs')
  for (const entry of await listDir(docsDir)) {
    if (!entry.isDirectory()) continue
    const candidate = path.join(docsDir, entry.name, 'model.json')
    if (await exists(candidate)) return candidate
  }
  return null
}

/** Normalize one review record from `metadata.artifact_reviews`. */
function reviewStatus(entry) {
  const value = String(entry?.status ?? entry?.review_status ?? '').toLowerCase()
  if (value.includes('agree') || value === 'approved') return 'agreed'
  if (value.includes('review')) return 'needs_review'
  return 'unknown'
}

/** Normalize one open question entry. */
function questionEntry(entry, index) {
  if (typeof entry === 'string') {
    return { id: `Q-${index + 1}`, level: 'minor', question: entry }
  }
  const level = String(entry?.level ?? entry?.severity ?? 'minor').toLowerCase()
  return {
    id: entry?.id ?? `Q-${index + 1}`,
    level,
    question: String(entry?.question ?? entry?.text ?? entry?.title ?? ''),
  }
}

/** Parse the lightweight `workflow.md` checkpoint written by the analyst. */
export function parseWorkflow(text) {
  if (!text) return null
  const field = (names) => {
    for (const name of names) {
      const match = text.match(new RegExp(`^\\s*[-*]?\\s*${name}\\s*:?\\s*(.+)$`, 'im'))
      if (match) return match[1].trim().replace(/\s+$/, '')
    }
    return null
  }
  return {
    stage: field(['Этап', 'Stage']),
    phase: field(['Фаза', 'Phase']),
    version: field(['Модель', 'Model', 'Версия', 'Version']),
    next: field(['Следующее действие', 'Следующий шаг', 'Next action', 'Next step']),
    check: field(['Проверка', 'Check']),
  }
}

/** Count entries in an array/record/collection field. */
function countOf(value) {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') return Object.keys(value).length
  return 0
}

/** Read the SSC change, or none when the project has no canonical model. */
export async function readSsc(root) {
  const modelPath = await findModel(root)
  if (!modelPath) return { changes: [] }

  const dir = path.dirname(modelPath)
  const relDir = relPath(root, dir)
  const text = await readTextSafe(modelPath, 8 * 1024 * 1024)
  const briefPath = path.join(dir, 'brief.md')
  const workflowPath = path.join(dir, 'workflow.md')
  const bpmnPath = path.join(dir, 'bpmn-outline.md')
  const historyDir = path.join(dir, 'history')

  const workflowText = await readTextSafe(workflowPath)
  const workflow = parseWorkflow(workflowText)
  const brief = await readTextSafe(briefPath)

  const base = {
    id: path.basename(dir) || 'ssc',
    practice: 'ssc',
    dir,
    relDir,
    archived: false,
    has: { spec: true, model: true, workflow: workflow !== null, history: await isDir(historyDir) },
    documents: [],
    artifacts: [],
    parseError: null,
  }

  let model = null
  try {
    model = text === null ? null : JSON.parse(text)
  } catch (error) {
    base.parseError = `model.json не разобран: ${error?.message ?? error}`
  }

  if (!model) {
    base.title = path.basename(dir) || 'ssc'
    base.tasks = { done: 0, total: 0, requirements: 0, businessRules: 0 }
    base.questions = { total: 0, blockers: 0 }
    base.review = { pending: 0, agreed: 0, total: 0 }
    base.status = 'unknown'
    base.workflow = workflow
    base.updatedAt = await mtimeMs(modelPath)
    base.createdAt = base.updatedAt
    base.documents = [relPath(root, modelPath)]
    base.artifacts = [{ id: 'model', path: relPath(root, modelPath), state: 'error' }]
    return { changes: [base] }
  }

  const metadata = model.metadata ?? {}
  const reviews = Array.isArray(metadata.artifact_reviews) ? metadata.artifact_reviews : []
  const normalizedReviews = reviews.map(reviewStatus)
  const pending = normalizedReviews.filter((status) => status === 'needs_review').length
  const agreed = normalizedReviews.filter((status) => status === 'agreed').length

  const questions = (Array.isArray(model.open_questions) ? model.open_questions : []).map(questionEntry)
  const blockers = questions.filter((question) => ['blocker', 'major', 'critical', 'high'].includes(question.level)).length

  const requirements = countOf(model.requirements) || countOf(model.business_rules)
  const businessRules = countOf(model.business_rules)
  const traceability = countOf(model.traceability)

  const requirementIds = []
  for (const collection of [model.requirements, model.business_rules]) {
    if (!Array.isArray(collection)) continue
    for (const entry of collection) {
      if (entry && typeof entry.id === 'string' && requirementIds.length < 300) requirementIds.push(entry.id)
    }
  }

  const historyFiles = (await isDir(historyDir))
    ? (await listDir(historyDir)).filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    : []
  const stamps = [
    await mtimeMs(modelPath),
    await mtimeMs(briefPath),
    await mtimeMs(workflowPath),
    ...(await Promise.all(historyFiles.map((entry) => mtimeMs(path.join(historyDir, entry.name))))),
  ].filter((value) => value > 0)

  const updatedAt = Math.max(0, ...stamps)
  const createdAt = stamps.length > 0 ? Math.min(...stamps) : updatedAt

  const documents = [relPath(root, modelPath)]
  if (await exists(briefPath)) documents.push(relPath(root, briefPath))
  if (await exists(workflowPath)) documents.push(relPath(root, workflowPath))
  if (await exists(bpmnPath)) documents.push(relPath(root, bpmnPath))

  const title = metadata.title || metadata.name || firstHeading(brief) || (Array.isArray(model.modules) && model.modules[0]?.name) || base.id

  return {
    changes: [
      {
        ...base,
        title,
        status: String(metadata.status ?? 'unknown').toLowerCase(),
        version: metadata.version ?? null,
        review: { pending, agreed, total: normalizedReviews.length },
        questions: { total: questions.length, blockers },
        tasks: { done: 0, total: 0, requirements, businessRules, traceability },
        requirementIds,
        workflow,
        historyVersions: historyFiles.length,
        createdAt,
        updatedAt,
        documents,
        artifacts: [
          { id: 'model', path: relPath(root, modelPath), state: base.parseError ? 'error' : 'done' },
          { id: 'brief', path: relPath(root, briefPath), state: (await exists(briefPath)) ? 'done' : 'missing' },
          { id: 'workflow', path: relPath(root, workflowPath), state: (await exists(workflowPath)) ? 'done' : 'missing' },
          {
            id: 'reviews',
            path: relPath(root, modelPath),
            state: pending > 0 ? 'pending' : normalizedReviews.length > 0 ? 'done' : 'missing',
          },
        ],
      },
    ],
  }
}
