import assert from 'node:assert/strict'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseTicketStatus } from '../src/adapters/scratch.js'
import { runChecks } from '../src/check.js'
import { normalizeConfig } from '../src/config.js'
import { detectPractice } from '../src/detect.js'
import { countCheckboxes, countQuestions } from '../src/fsx.js'
import { isArtifactPath, isCodePath, parsePorcelain, pathCommitRange, recentDriftFiles } from '../src/project.js'
import { promptText, sessionText, statusText } from '../src/render.js'
import { gateReasonText, writeWarningText } from '../src/render.js'
import { advanceText, portfolioText } from '../src/render.js'
import { SddService } from '../src/service.js'
import { buildState, phaseForOpenspec, phaseForScratch, phaseForSsc, selectActive } from '../src/state.js'
import { annotatedChangedFiles, collectAnnotations, looksLikeId, parseAnnotations } from '../src/trace.js'
import { median, percentile } from '../src/stats.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => path.join(here, 'fixtures', name)

function projectFor(root) {
  return {
    root,
    name: path.basename(root),
    isGit: false,
    branch: null,
    dirty: 0,
    changedFiles: [],
    codeChanges: [],
  }
}

/**
 * Copy a fixture outside the repository: service tests resolve the project
 * root through git, so a fixture inside the plugin repo would resolve to the
 * repository root instead of itself.
 */
async function tempFixture(name) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sdd-compass-'))
  const root = path.join(dir, name)
  await cp(fixture(name), root, { recursive: true })
  return { dir, root, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

async function stateFor(name, config) {
  const root = fixture(name)
  return buildState({
    root,
    project: projectFor(root),
    config: config ? normalizeConfig(config) : undefined,
    now: Date.now(),
  })
}

test('detectPractice finds openspec and scratch markers', async () => {
  assert.equal((await detectPractice(fixture('openspec'))).practice, 'openspec')
  assert.equal((await detectPractice(fixture('scratch'))).practice, 'scratch')
  assert.equal((await detectPractice(fixture('plain'))).practice, 'unknown')
  assert.equal((await detectPractice(fixture('plain'), { practice: 'openspec' })).practice, 'openspec')
})

test('countCheckboxes and countQuestions', () => {
  assert.deepEqual(countCheckboxes('- [x] a\n- [ ] b\n* [X] c'), { done: 2, total: 3 })
  assert.deepEqual(countCheckboxes('no tasks'), { done: 0, total: 0 })
  const text = '# X\n\n## Open Questions\n\n- Q1\n- Q2\n\n## Other\n- not a question'
  assert.equal(countQuestions(text), 2)
})

test('parseTicketStatus reads the scratch status line', () => {
  assert.equal(parseTicketStatus('**Status:** ready-for-agent'), 'ready-for-agent')
  assert.equal(parseTicketStatus('- **Status:** done'), 'done')
  assert.equal(parseTicketStatus('no status'), null)
})

test('phase ladders', () => {
  assert.equal(phaseForOpenspec({ archived: true }), 'archive')
  assert.equal(phaseForOpenspec({ has: { proposal: false } }), 'proposal')
  assert.equal(phaseForOpenspec({ has: { proposal: true, specs: false } }), 'spec')
  assert.equal(phaseForOpenspec({ has: { proposal: true, specs: true, design: false } }), 'design')
  assert.equal(phaseForOpenspec({ has: { proposal: true, specs: true, design: true, tasks: false } }), 'tasks')
  assert.equal(
    phaseForOpenspec({ has: { proposal: true, specs: true, design: true, tasks: true }, tasks: { done: 1, total: 3 } }),
    'apply',
  )
  assert.equal(
    phaseForOpenspec({ has: { proposal: true, specs: true, design: true, tasks: true }, tasks: { done: 3, total: 3 } }),
    'verify',
  )

  assert.equal(phaseForScratch({ has: { spec: false } }), 'spec')
  assert.equal(phaseForScratch({ has: { spec: true }, tasks: { done: 0, total: 0, active: 0 } }), 'tasks')
  assert.equal(phaseForScratch({ has: { spec: true }, tasks: { done: 1, total: 2, active: 0 } }), 'apply')
  assert.equal(phaseForScratch({ has: { spec: true }, tasks: { done: 2, total: 2, active: 0 } }), 'verify')

  assert.equal(phaseForSsc({ review: { pending: 1 }, status: 'needs_review', questions: { blockers: 0 } }), 'spec')
  assert.equal(phaseForSsc({ review: { pending: 0 }, status: 'agreed', questions: { blockers: 2 } }), 'spec')
  assert.equal(phaseForSsc({ review: { pending: 0 }, status: 'agreed', questions: { blockers: 0 } }), 'verify')
  assert.equal(phaseForSsc({ parseError: 'broken' }), 'unknown')
})

test('selectActive prefers the freshest unfinished change', () => {
  const changes = [
    { id: 'old', archived: true, updatedAt: 300 },
    { id: 'done', archived: false, updatedAt: 100 },
    { id: 'fresh', archived: false, updatedAt: 200 },
  ]
  assert.equal(selectActive(changes, 'auto').id, 'fresh')
  assert.equal(selectActive(changes, 'old').id, 'old')
  assert.equal(selectActive([], 'auto'), null)
})

test('openspec state: active change, phase apply, tasks and questions', async () => {
  const state = await stateFor('openspec')
  assert.equal(state.practice, 'openspec')
  assert.equal(state.practiceSupported, true)
  assert.equal(state.phase, 'apply')
  assert.equal(state.change.id, 'alpha')
  assert.deepEqual(state.change.tasks, { done: 1, total: 3 })
  assert.equal(state.change.questions.total, 2)
  assert.match(state.next.label, /реализовать/)
  assert.ok(state.docs.some((doc) => doc.path.includes('proposal.md')))
  assert.equal(state.blocked, false)
})

test('openspec archived change is the archive phase when selected', async () => {
  const state = await stateFor('openspec', { change: 'beta' })
  assert.equal(state.phase, 'archive')
  assert.equal(state.change.archived, true)
  assert.equal(state.next.id, 'done')
})

test('scratch state: ticket statuses drive the phase', async () => {
  const state = await stateFor('scratch')
  assert.equal(state.practice, 'scratch')
  assert.equal(state.phase, 'apply')
  assert.equal(state.change.id, 'catalog-api')
  assert.equal(state.change.tasks.done, 1)
  assert.equal(state.change.tasks.total, 2)
  assert.equal(state.change.questions.total, 1)
  assert.match(state.next.label, /1\/2/)
})

test('unknown project stays silent in the prompt and honest in status', async () => {
  const state = await stateFor('plain')
  assert.equal(state.practice, 'unknown')
  assert.equal(promptText(state), '')
  assert.match(statusText(state), /не распознана/)
})

test('prompt and session text are present and bounded', async () => {
  const state = await stateFor('openspec')
  const prompt = promptText(state)
  const session = sessionText(state)
  assert.ok(prompt.includes('фаза'))
  assert.ok(prompt.includes('alpha'))
  assert.ok(prompt.length <= 700, `prompt too long: ${prompt.length}`)
  assert.ok(session.includes('alpha'))
  assert.ok(session.length <= 950, `session too long: ${session.length}`)
})

test('drift is reported when code changes during the spec phase', async () => {
  const root = fixture('openspec-spec')
  const project = {
    ...projectFor(root),
    dirty: 1,
    changedFiles: ['src/api/export.ts'],
    codeChanges: ['src/api/export.ts'],
  }
  const state = await buildState({ root, project, now: Date.now() })
  assert.equal(state.phase, 'spec')
  const drift = state.findings.find((finding) => finding.rule === 'drift.code-without-change')
  assert.ok(drift, `expected drift finding, got ${JSON.stringify(state.findings)}`)
  assert.equal(drift.severity, 'warn')
  assert.deepEqual(drift.paths, ['src/api/export.ts'])
})

test('artifact paths and porcelain parsing', () => {
  assert.equal(isArtifactPath('openspec/changes/x/proposal.md'), true)
  assert.equal(isArtifactPath('docs/README.md'), true)
  assert.equal(isArtifactPath('src/api/export.ts'), false)
  assert.equal(isCodePath('src/api/export.ts'), true)
  assert.equal(isCodePath('Makefile'), true)
  assert.equal(isCodePath('image.png'), false)
  assert.equal(isCodePath('.omo/state.json'), false)
  assert.equal(isCodePath('docs/catalog.md'), false)
  assert.deepEqual(parsePorcelain(' M src/a.ts\n?? .sdd/\nR  old.txt -> new.txt'), ['src/a.ts', '.sdd/', 'new.txt'])
})

test('git history helpers parse injected command output', async () => {
  const project = { isGit: true, root: '/repo' }
  const runner = async (_root, args) => {
    if (args[0] === 'log' && args.includes('--format=%ct')) return '1700000000\n1700400000\n1700800000'
    if (args[0] === 'log') return 'src/a.ts\nopenspec/changes/x/proposal.md\n\ndocs/b.md\nsrc/c.ts'
    return null
  }
  const range = await pathCommitRange(project, ['openspec/changes/x'], runner)
  assert.equal(range.commits, 3)
  assert.equal(range.first, 1700000000)
  assert.equal(range.last, 1700800000)

  const drift = await recentDriftFiles(project, 7, runner)
  assert.deepEqual(drift, ['src/a.ts', 'src/c.ts'])
})

test('median and percentile', () => {
  assert.equal(median([]), 0)
  assert.equal(median([3, 1, 2]), 2)
  assert.equal(median([4, 1, 3, 2]), 2.5)
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9)
})

test('checks: stale change and pending archive', async () => {
  const day = 86_400_000
  const now = Date.now()
  const base = {
    project: projectFor('/tmp/x'),
    practice: 'openspec',
    changes: [],
    config: normalizeConfig({}),
    driftPaths: null,
    archivedCount: 0,
    candidates: ['openspec'],
  }
  const stale = runChecks({
    ...base,
    now,
    change: { phase: 'apply', updatedAt: now - 30 * day, archived: false, tasks: { done: 0, total: 2 } },
  })
  assert.ok(stale.some((finding) => finding.rule === 'change.stale' && finding.severity === 'warn'))

  const pending = runChecks({
    ...base,
    now,
    change: { phase: 'verify', updatedAt: now - 10 * day, archived: false, tasks: { done: 2, total: 2 }, has: { tasks: true } },
  })
  assert.ok(pending.some((finding) => finding.rule === 'archive.pending'))
})

test('service resolves a pre-existing session from persisted headers', async () => {
  const temp = await tempFixture('openspec')
  const root = temp.root
  const ctx = {
    get(name) {
      if (name !== 'sessionPersistence') return undefined
      return { list: async () => [{ id: 'old-session', cwd: root }] }
    },
  }
  const service = new SddService(ctx)
  try {
    assert.equal(await service.cwdForSession('old-session'), root)
    assert.equal(service.cwdFor('old-session'), root)
    const state = await service.ensureState(root)
    assert.equal(state.practice, 'openspec')
  } finally {
    service.dispose()
    await temp.cleanup()
  }
})

test('ssc state: model reviews and blockers drive the phase', async () => {
  const state = await stateFor('ssc')
  assert.equal(state.practice, 'ssc')
  assert.equal(state.practiceSupported, true)
  assert.equal(state.phase, 'spec')
  assert.equal(state.change.questions.total, 2)
  assert.equal(state.change.questions.blockers, 1)
  assert.equal(state.change.review.pending, 1)
  assert.equal(state.change.tasks.requirements, 1)
  assert.equal(state.change.workflow.next, 'Представить обновлённое правило.')
  assert.ok(state.findings.some((finding) => finding.rule === 'ssc.review'))
  assert.ok(state.findings.some((finding) => finding.rule === 'ssc.blockers'))
  assert.ok(state.docs.some((doc) => doc.path.endsWith('model.json')))
})

test('docs: changed module documentation is picked and labelled', async () => {
  const root = fixture('docs')
  const project = {
    ...projectFor(root),
    dirty: 1,
    changedFiles: ['src/catalog/api.ts'],
    codeChanges: ['src/catalog/api.ts'],
  }
  const state = await buildState({ root, project, now: Date.now() })
  const doc = state.docs.find((entry) => entry.path === 'docs/catalog.md')
  assert.ok(doc, `expected docs/catalog.md, got ${JSON.stringify(state.docs)}`)
  assert.equal(doc.why, 'документация изменённого модуля')
})

test('write warning and gate text respect phase and strictness', () => {
  const base = {
    phase: 'spec',
    phaseLabel: 'спека',
    change: { id: 'alpha' },
    next: { label: 'согласовать спеку', hint: '/sdd next' },
    strictness: 'warn',
  }
  const warning = writeWarningText(base, 'src/api/export.ts')
  assert.match(warning, /дрейф/)
  assert.match(warning, /согласовать спеку/)
  assert.equal(writeWarningText({ ...base, strictness: 'info' }, 'src/api/export.ts'), '')
  assert.equal(writeWarningText({ ...base, phase: 'apply' }, 'src/api/export.ts'), '')
  assert.match(gateReasonText({ ...base, strictness: 'gate' }, 'src/api/export.ts'), /гейт/)
  assert.equal(gateReasonText(base, 'src/api/export.ts'), '')
})

test('service warns on code writes but not on artifact writes', async () => {
  const temp = await tempFixture('openspec-spec')
  const root = temp.root
  const service = new SddService()
  const exec = (target) => ({
    name: 'write',
    arguments: { file_path: target },
    agent: { session: { header: { cwd: root } } },
  })
  try {
    const warning = await service.writeWarning(exec('src/api/export.ts'))
    assert.ok(warning, 'expected a warning for a code path')
    assert.equal(warning.source.kind, 'plugin')
    assert.equal(await service.writeWarning(exec('openspec/changes/gamma/proposal.md')), null)
    assert.equal(await service.writeWarning({ ...exec('src/api/export.ts'), name: 'read' }), null)
  } finally {
    service.dispose()
    await temp.cleanup()
  }
})

test('service gate denies code writes only under strictness gate', async () => {
  const gateTemp = await tempFixture('gate')
  const gateService = new SddService()
  const exec = (target) => ({
    name: 'edit',
    arguments: { path: target },
    agent: { session: { header: { cwd: gateTemp.root } } },
  })
  try {
    const state = await gateService.ensureState(gateTemp.root)
    assert.equal(state.phase, 'spec')
    assert.equal(state.strictness, 'gate')
    assert.match(await gateService.gateReason(exec('src/api/export.ts')), /гейт/)
    assert.equal(await gateService.gateReason(exec('openspec/changes/one/proposal.md')), null)
    assert.equal(await gateService.gateReason({ ...exec('src/api/export.ts'), name: 'read' }), null)
  } finally {
    gateService.dispose()
    await gateTemp.cleanup()
  }

  const warnTemp = await tempFixture('openspec-spec')
  const warnService = new SddService()
  try {
    const state = await warnService.ensureState(warnTemp.root)
    assert.equal(state.strictness, 'warn')
    assert.equal(
      await warnService.gateReason({
        name: 'write',
        arguments: { file_path: 'src/api/export.ts' },
        agent: { session: { header: { cwd: warnTemp.root } } },
      }),
      null,
    )
  } finally {
    warnService.dispose()
    await warnTemp.cleanup()
  }
})

test('scratch checks: closed tickets with open checkboxes', () => {
  const now = Date.now()
  const findings = runChecks({
    project: projectFor('/tmp/x'),
    practice: 'scratch',
    changes: [],
    config: normalizeConfig({}),
    driftPaths: null,
    archivedCount: 0,
    candidates: ['scratch'],
    now,
    change: {
      phase: 'apply',
      archived: false,
      updatedAt: now - 2 * 86_400_000,
      tasks: { done: 1, total: 2, active: 0 },
      issues: [
        { id: '01-setup', status: 'done', checkboxes: { done: 0, total: 2 }, path: '.scratch/x/issues/01-setup.md' },
        { id: '02-api', status: 'ready-for-agent', checkboxes: { done: 0, total: 0 }, path: '.scratch/x/issues/02-api.md' },
      ],
    },
  })
  assert.ok(findings.some((finding) => finding.rule === 'ticket.checkboxes' && finding.severity === 'warn'))
})

test('annotation parsing and helpers', () => {
  assert.deepEqual(parseAnnotations('// @sdd FR-012\n/* @sdd: change-x */\n@sdd = BR-3'), ['FR-012', 'change-x', 'BR-3'])
  assert.equal(looksLikeId('FR-012'), true)
  assert.equal(looksLikeId('change-x'), false)
  assert.deepEqual(annotatedChangedFiles({ files: 1, byId: { 'FR-1': ['src/a.ts'] } }, ['src/a.ts', 'src/b.ts']), ['src/a.ts'])
})

test('trace state: coverage, unknown ids and findings', async () => {
  const state = await stateFor('trace')
  assert.equal(state.practice, 'ssc')
  assert.equal(state.phase, 'verify')
  assert.equal(state.trace.requirementIds, 3)
  assert.equal(state.trace.covered, 1)
  assert.deepEqual(state.trace.unknown, ['BR-999'])
  assert.ok(state.findings.some((finding) => finding.rule === 'trace.unknown'))
  assert.ok(state.findings.some((finding) => finding.rule === 'trace.orphan'))
})

test('collectAnnotations scans code roots', async () => {
  const root = fixture('trace')
  const trace = await collectAnnotations(root, { roots: ['src'], maxFiles: 50 })
  assert.equal(trace.files, 2)
  assert.deepEqual(trace.byId['FR-001'], ['src/catalog.ts'])
  assert.deepEqual(trace.byId['BR-999'], ['src/flags.ts'])
})

test('advance text names the exact command and never executes it', () => {
  const text = advanceText({
    practice: 'openspec',
    phase: 'verify',
    phaseLabel: 'проверка',
    change: { id: 'alpha' },
    next: { label: 'проверить и заархивировать' },
  })
  assert.match(text, /openspec archive --change alpha/)
  assert.match(text, /вручную/)
  assert.equal(advanceText({ phase: 'idle' }).includes('/sdd init'), true)
})

test('portfolio lists workspace projects', async () => {
  const temp = await tempFixture('openspec')
  const ctx = {
    get(name) {
      if (name !== 'workspaceRegistry') return undefined
      return { list: () => [{ path: temp.root }] }
    },
  }
  const service = new SddService(ctx)
  try {
    const rows = await service.portfolio()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].practice, 'openspec')
    assert.ok(rows[0].phaseLabel)
    assert.match(portfolioText(rows), /openspec/)
  } finally {
    service.dispose()
    await temp.cleanup()
  }
})
