/**
 * SddService: owns project detection, the per-root state cache, the session →
 * directory map, filesystem watching and every surface the plugin exposes.
 *
 * The service never writes to project sources. The only write it offers is
 * `/sdd init`, which creates `.sdd/config.json` and refuses to overwrite.
 */

import { promises as fsp, statSync, watch as fsWatch } from 'node:fs'
import path from 'node:path'
import { configTemplate } from './config.js'
import { detectPractice } from './detect.js'
import { isArtifactPath, resolveProject } from './project.js'
import * as render from './render.js'
import { buildState } from './state.js'
import { PHASE_LABELS } from './state.js'

const TTL_MS = 15_000
const DEBOUNCE_MS = 400

/** Tools that mutate files; only these participate in SDD nudges. */
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor', 'write_file', 'create_file', 'multi_edit'])

/** JSON response helper for the HTTP route. */
function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Generate a model-facing plugin message. */
let messageSeq = 0
function pluginMessage(text) {
  messageSeq += 1
  return {
    id: `sdd-compass-${Date.now()}-${messageSeq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'sdd-compass' },
  }
}

export class SddService {
  constructor(ctx = null) {
    this.ctx = ctx
    /** @type {Map<string, { state: any, at: number }>} root → cached state */
    this.projects = new Map()
    /** @type {Map<string, string>} sessionId → cwd */
    this.sessions = new Map()
    /** @type {Map<string, string>} cwd → project root */
    this.roots = new Map()
    /** @type {Map<string, Promise<any>>} root → in-flight build */
    this.inflight = new Map()
    /** @type {Map<string, any>} root → git aggregate cache */
    this.gitCache = new Map()
    /** @type {Map<string, { close: () => void, timer: any }>} root → watcher debounce */
    this.watchers = new Map()
    /** @type {Set<string>} sessions already seeded */
    this.seeded = new Set()
    this.portfolioCache = new Map()
    this.disposed = false
  }

  /** Remember which directory a session works in. */
  rememberSession(sessionId, cwd) {
    if (!sessionId || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null
    this.sessions.set(sessionId, cwd)
    void this.ensureState(cwd).catch(() => {})
    return cwd
  }

  /** Resolve a session's directory, or null. */
  cwdFor(sessionId) {
    if (!sessionId) return null
    return this.sessions.get(sessionId) ?? null
  }

  /**
   * Resolve a session's directory, falling back to the persisted header for
   * sessions that started before this plugin was loaded.
   */
  async cwdForSession(sessionId) {
    const known = this.cwdFor(sessionId)
    if (known) return known
    if (!sessionId || !this.ctx) return null
    try {
      const persistence = this.ctx.get?.('sessionPersistence') ?? null
      if (!persistence?.list) return null
      const snapshots = await persistence.list()
      const bare = String(sessionId).replace(/^session-/, '')
      const header = (snapshots ?? [])
        .map((item) => item?.header ?? item)
        .find(
          (item) => item?.id === sessionId || item?.id === `session-${bare}` || String(item?.id).replace(/^session-/, '') === bare,
        )
      if (header?.cwd) {
        this.rememberSession(sessionId, header.cwd)
        return header.cwd
      }
    } catch {
      // Persistence is optional; without it new sessions still register via events.
    }
    return null
  }

  /** Resolve and cache the project root for a directory. */
  async rootFor(cwd) {
    if (!cwd) return null
    const known = this.roots.get(cwd)
    if (known) return known
    const project = await resolveProject(cwd)
    this.roots.set(cwd, project.root)
    return project.root
  }

  /**
   * Compute (or return cached) state for a directory.
   * @param {string} cwd - absolute session directory.
   * @param {boolean} [force] - bypass the freshness check.
   */
  async ensureState(cwd, force = false) {
    if (!cwd) return null
    const root = await this.rootFor(cwd)
    if (!root) return null

    const cached = this.projects.get(root)
    if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.state

    const running = this.inflight.get(root)
    if (running) return running

    const promise = (async () => {
      const project = await resolveProject(root)
      const state = await buildState({ root, project, cache: this.gitCache })
      this.projects.set(root, { state, at: Date.now() })
      this.watch(root)
      return state
    })()

    this.inflight.set(root, promise)
    try {
      return await promise
    } finally {
      this.inflight.delete(root)
    }
  }

  /** Best-effort synchronous state for the prompt provider. */
  cachedStateFor(cwd) {
    if (!cwd) return null
    const root = this.roots.get(cwd)
    if (!root) {
      void this.ensureState(cwd).catch(() => {})
      return null
    }
    const cached = this.projects.get(root)
    if (!cached) {
      void this.ensureState(cwd).catch(() => {})
      return null
    }
    if (Date.now() - cached.at >= TTL_MS) void this.ensureState(cwd).catch(() => {})
    return cached.state
  }

  /**
   * System-prompt section text. Synchronous by contract: it renders the last
   * computed state and asks for a background refresh when that state is old.
   */
  promptText(context) {
    const cwd = context?.agent?.session?.header?.cwd
    if (!cwd) return ''
    this.rememberSession(context.agent?.id, cwd)
    const state = this.cachedStateFor(cwd)
    return state ? render.promptText(state) : ''
  }

  /** Seed the model with the SDD briefing once per session. */
  async seed(agent) {
    if (!agent || this.disposed) return
    const cwd = agent.session?.header?.cwd
    if (!cwd) return
    this.rememberSession(agent.id, cwd)
    if (this.seeded.has(agent.id)) return
    this.seeded.add(agent.id)
    try {
      const state = await this.ensureState(cwd)
      const text = render.sessionText(state)
      if (text && typeof agent.inject === 'function') agent.inject(pluginMessage(text))
    } catch {
      // Seeding is best-effort; a failed briefing never breaks the session.
    }
  }

  /** Invalidate a project's cached state. */
  invalidate(root) {
    const cached = this.projects.get(root)
    if (cached) this.projects.set(root, { state: cached.state, at: 0 })
  }

  /** Watch the SDD-relevant directories of a project for changes. */
  watch(root) {
    if (this.disposed || this.watchers.has(root)) return
    const targets = ['openspec', '.scratch', 'docs', '.sdd']
    const closed = []
    let timer = null
    const invalidate = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        this.invalidate(root)
        for (const cwd of this.roots.keys()) {
          if (this.roots.get(cwd) === root) void this.ensureState(cwd, true).catch(() => {})
        }
      }, DEBOUNCE_MS)
      if (timer.unref) timer.unref()
    }

    for (const target of targets) {
      const dir = path.join(root, target)
      try {
        if (!statSync(dir)) continue
        const watcher = fsWatch(dir, { recursive: true }, invalidate)
        closed.push(() => watcher.close())
      } catch {
        // Directory missing or watching unsupported: polling via TTL still works.
      }
    }

    this.watchers.set(root, {
      close() {
        if (timer) clearTimeout(timer)
        for (const close of closed) {
          try {
            close()
          } catch {
            // ignore
          }
        }
      },
    })
  }

  /** Debug helper for the route: what persistence sees (loopback-only). */
  async sessionDiagnostics() {
    const persistence = this.ctx?.get?.('sessionPersistence') ?? null
    let count = null
    let error = null
    try {
      const snapshots = await persistence?.list?.()
      count = Array.isArray(snapshots) ? snapshots.length : null
    } catch (failure) {
      error = String(failure?.message ?? failure)
    }
    return { available: Boolean(persistence?.list), count, error }
  }

  /** Handle GET /api/sdd?sessionId=…&refresh=1 and GET /api/sdd/projects. */
  async handleHttp(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (url.pathname.replace(/\/+$/, '').endsWith('/projects')) {
        return json(res, 200, { ok: true, projects: await this.portfolio() })
      }
      if (url.pathname.replace(/\/+$/, '').endsWith('/search')) {
        const sessionId = url.searchParams.get('sessionId') || null
        const cwd = await this.cwdForSession(sessionId)
        const found = await this.search(url.searchParams.get('q') ?? '', cwd)
        return json(res, 200, { ok: true, ...found })
      }
      const sessionId = url.searchParams.get('sessionId') || null
      let cwd = await this.cwdForSession(sessionId)
      if (!cwd && !sessionId && this.sessions.size === 1) {
        // The dock may not receive a session id; with exactly one mapped
        // session there is no ambiguity about which project to show.
        cwd = [...this.sessions.values()][0] ?? null
      }
      if (!cwd) {
        const payload = { ok: false, error: 'no-session' }
        if (url.searchParams.get('debug') === '1') {
          payload.debug = { hasCtx: Boolean(this.ctx), mapped: this.sessions.size }
          payload.debug.persistence = await this.sessionDiagnostics()
        }
        return json(res, 200, payload)
      }
      const state = await this.ensureState(cwd, url.searchParams.get('refresh') === '1')
      return json(res, 200, { ok: true, state })
    } catch (error) {
      return json(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  /** Portfolio: one row per workspace project the host knows about. */
  async portfolio() {
    const cached = this.portfolioCache?.get('rows')
    if (cached && Date.now() - cached.at < 30_000) return cached.rows
    const registry = this.ctx?.get?.('workspaceRegistry') ?? null
    const workspaces = Array.isArray(registry?.list?.()) ? registry.list() : []
    const paths = workspaces.map((workspace) => workspace?.path).filter((value) => typeof value === 'string').slice(0, 12)
    const rows = []
    for (const target of paths) {
      try {
        const state = await this.ensureState(target)
        if (!state) continue
        rows.push({
          name: state.project.name,
          path: state.project.root,
          practice: state.practice,
          phase: state.phase,
          phaseLabel: state.phaseLabel,
          change: state.change?.id ?? null,
          warnings: state.findings.filter((finding) => finding.severity !== 'info').length,
        })
      } catch {
        rows.push({
          name: path.basename(target),
          path: target,
          practice: 'unknown',
          phase: 'unknown',
          phaseLabel: 'ошибка',
          change: null,
          warnings: 0,
          error: true,
        })
      }
    }
    rows.sort((left, right) => left.name.localeCompare(right.name))
    this.portfolioCache ??= new Map()
    this.portfolioCache.set('rows', { at: Date.now(), rows })
    return rows
  }

  /**
   * Internal search across the panel's content: projects, changes,
   * documents, artifacts and findings of the current project.
   * @param {string} query
   * @param {string|null} cwd
   */
  async search(query, cwd) {
    const q = String(query ?? '').trim().toLowerCase()
    if (q.length < 2) return { query: q, results: [] }

    const results = []
    const seen = new Set()
    const add = (kind, title, subtitle, pathValue, weight = 0) => {
      const key = `${kind}:${title}:${pathValue ?? ''}`
      if (seen.has(key)) return
      seen.add(key)
      const haystack = `${title} ${subtitle ?? ''} ${pathValue ?? ''}`.toLowerCase()
      const index = haystack.indexOf(q)
      if (index < 0) return
      results.push({
        kind,
        title,
        subtitle: subtitle ?? null,
        path: pathValue ?? null,
        score: (index === 0 || title.toLowerCase().startsWith(q) ? 100 : 50) + weight,
      })
    }

    for (const project of await this.portfolio()) {
      add('project', project.name, `${project.practice} · ${project.phaseLabel}`, project.path, 5)
    }

    const state = cwd ? await this.ensureState(cwd) : null
    if (state) {
      for (const change of state.changes ?? []) {
        add('change', change.id, `${PHASE_LABELS[change.phase] ?? change.phase} · ${change.title ?? ''}`, null, 8)
        for (const document of change.documents ?? []) {
          add('doc', document.split('/').pop() ?? document, `артефакт изменения "${change.id}" · ${document}`, document, 4)
        }
      }
      for (const doc of state.docs ?? []) add('doc', doc.path.split('/').pop() ?? doc.path, `${doc.why} · ${doc.path}`, doc.path, 3)
      for (const finding of state.findings ?? []) add('finding', finding.message, finding.rule, null, 1)
      for (const artifact of state.change?.artifacts ?? []) {
        if (artifact?.path) add('doc', artifact.path.split('/').pop() ?? artifact.path, 'артефакт изменения', artifact.path, 3)
      }
    }

    results.sort((left, right) => right.score - left.score || left.kind.localeCompare(right.kind))
    return { query: q, results: results.slice(0, 30) }
  }

  /** Tool `sdd_projects`: portfolio rows. */
  async projects() {
    return { ok: true, projects: await this.portfolio() }
  }

  /** `/sdd` command handler. */
  async command(invocation) {
    try {
      const cwd = invocation?.agent?.session?.header?.cwd
      if (!cwd) return { kind: 'error', text: 'Не удалось определить рабочий каталог сессии.' }
      const raw = String(invocation.rawInput ?? '').trim()
      const [sub = 'status', ...rest] = raw.split(/\s+/).filter(Boolean)
      this.rememberSession(invocation.agent?.id, cwd)

      if (sub === 'help') {
        return {
          kind: 'success',
          text: [
            '/sdd — состояние',
            '/sdd next — следующий шаг',
            '/sdd advance — точная команда следующего шага',
            '/sdd archive — команда архивации (в фазе проверки)',
            '/sdd check — замечания',
            '/sdd docs — документы',
            '/sdd stats — статистика',
            '/sdd report — отчёт в markdown',
            '/sdd projects — сводка по проектам',
            '/sdd init [practice] — создать .sdd/config.json',
            '/sdd refresh — пересчитать',
          ].join('\n'),
        }
      }
      if (sub === 'init') return this.init(cwd, rest[0])
      if (sub === 'projects') return { kind: 'success', text: render.portfolioText(await this.portfolio()) }
      if (sub === 'refresh') {
        const state = await this.ensureState(cwd, true)
        return { kind: 'success', text: render.statusText(state) }
      }

      const state = await this.ensureState(cwd)
      if (!state) return { kind: 'error', text: 'Не удалось вычислить состояние SDD.' }
      if (sub === 'status') return { kind: 'success', text: render.statusText(state) }
      if (sub === 'next') return { kind: 'success', text: render.nextText(state) }
      if (sub === 'advance') return { kind: 'success', text: render.advanceText(state) }
      if (sub === 'archive') {
        if (state.phase !== 'verify') return { kind: 'error', text: `Изменение не в фазе проверки (${state.phaseLabel}), архивировать нечего.` }
        return { kind: 'success', text: render.advanceText(state) }
      }
      if (sub === 'check') return { kind: 'success', text: render.findingsText(state) }
      if (sub === 'docs') return { kind: 'success', text: render.docsText(state) }
      if (sub === 'stats') return { kind: 'success', text: render.statsText(state) }
      if (sub === 'report') return { kind: 'success', text: render.reportText(state) }
      return { kind: 'error', text: `Неизвестная подкоманда: ${sub}. /sdd help` }
    } catch (error) {
      return { kind: 'error', text: String(error?.message ?? error) }
    }
  }

  /** Create `.sdd/config.json` without overwriting an existing file. */
  async init(cwd, practice) {
    const root = (await this.rootFor(cwd)) ?? cwd
    const dir = path.join(root, '.sdd')
    const file = path.join(dir, 'config.json')
    const detection = await detectPractice(root, {})
    const chosen = practice || (detection.practice === 'unknown' ? 'auto' : detection.practice)
    await fsp.mkdir(dir, { recursive: true })
    try {
      await fsp.writeFile(file, configTemplate(chosen), { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if (error?.code === 'EEXIST') return { kind: 'success', text: `Конфиг уже существует: ${file}` }
      throw error
    }
    this.invalidate(root)
    return { kind: 'success', text: `Создан ${file} (practice: ${chosen}). Правится руками; /sdd refresh пересчитает состояние.` }
  }

  /** Tool `sdd_status`: the full computed state. */
  async status(exec, force = false) {
    const cwd = exec?.agent?.session?.header?.cwd
    const state = await this.ensureState(cwd, force)
    if (!state) return { ok: false, error: 'no-session' }
    return {
      ok: true,
      project: state.project,
      practice: state.practice,
      phase: state.phase,
      phaseLabel: state.phaseLabel,
      change: state.change,
      next: state.next,
      findings: state.findings,
      docs: state.docs,
      stats: state.stats.snapshot,
      history: state.stats.history,
      trace: state.trace,
      links: state.links,
      changes: state.changes,
    }
  }

  /** Tool `sdd_check`: findings only. */
  async check(exec, force = false) {
    const cwd = exec?.agent?.session?.header?.cwd
    const state = await this.ensureState(cwd, force)
    if (!state) return { ok: false, error: 'no-session', findings: [] }
    return { ok: true, findings: state.findings, blocked: state.blocked }
  }

  /** The file a write-like tool targets, or null. */
  static writtenPath(exec) {
    const args = exec?.arguments ?? {}
    const candidate = args.file_path ?? args.path ?? args.file ?? args.target_file ?? null
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
  }

  /**
   * Model-facing warning after a code write in a pre-implementation phase.
   * Returns a plugin message, or null when no nudge applies.
   */
  async writeWarning(exec) {
    if (!WRITE_TOOLS.has(exec?.name)) return null
    const cwd = exec?.agent?.session?.header?.cwd
    const target = SddService.writtenPath(exec)
    if (!cwd || !target || isArtifactPath(target)) return null
    const state = this.cachedStateFor(cwd) ?? (await this.ensureState(cwd))
    const text = render.writeWarningText(state, target)
    return text ? pluginMessage(text) : null
  }

  /** Denial reason for the opt-in hard gate, or null. */
  async gateReason(exec) {
    if (!WRITE_TOOLS.has(exec?.name)) return null
    const cwd = exec?.agent?.session?.header?.cwd
    const target = SddService.writtenPath(exec)
    if (!cwd || !target || isArtifactPath(target)) return null
    const state = this.cachedStateFor(cwd) ?? (await this.ensureState(cwd))
    if (!state || state.strictness !== 'gate') return null
    if (!['proposal', 'spec', 'design'].includes(state.phase)) return null
    const reason = render.gateReasonText(state, target)
    return reason || null
  }

  /** Release watchers, timers and caches. */
  dispose() {
    this.disposed = true
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    this.projects.clear()
    this.inflight.clear()
    this.gitCache.clear()
    this.sessions.clear()
    this.roots.clear()
    this.seeded.clear()
  }
}
