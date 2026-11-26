/**
 * SddService: owns project detection, the per-root state cache, the session →
 * directory map, filesystem watching and every surface the plugin exposes.
 *
 * The service never writes to project sources. The only write it offers is
 * `/sdd init`, which creates `.sdd/config.json` and refuses to overwrite.
 */

import { promises as fsp, statSync, watch as fsWatch } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { configTemplate } from './config.js'
import { buildDigest, digestText } from './digest.js'
import { detectPractice } from './detect.js'
import { isArtifactPath, resolveProject } from './project.js'
import * as render from './render.js'
import { buildState } from './state.js'
import { setTaskColumn } from './tasks.js'

const TTL_MS = 15_000
const DEBOUNCE_MS = 400

/** Tools that mutate files; only these participate in SDD nudges. */
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'str_replace_editor', 'write_file', 'create_file', 'multi_edit'])

/** One user-role message produced by the plugin for a chat prompt. */
function chatMessage(text) {
  return {
    id: `sdd-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** Prompt that starts work on a task. */
function taskPrompt(task) {
  return [
    `Начни работу над задачей «${task.title}» (ID ${task.id}, файл ${task.path}).`,
    'Сначала прочитай задачу и относящуюся к ней спеку, составь короткий план, затем выполняй.',
    'Отмечай прогресс в SDD-компасе (/sdd next) и в самой задаче.',
  ].join(' ')
}

/** Prompt that starts a new feature through grilling. */
function featurePrompt(features) {
  const skill = features?.grilling
    ? 'Используй скилл grilling.'
    : 'Используй скилл grilling; если его нет в проекте — возьми его из https://github.com/AndrewGanzha/basic-skills/tree/main/skills/grilling.'
  return [
    `${skill} Заведи новую задачу (фичу) в этом проекте.`,
    'Изучи документацию проекта и проведи grilling: задавай мне вопросы по одному, пока не прояснишь требования, границы и критерии приёмки.',
    'Затем оформи документацию: spec.md и задачи (issues/tasks) по правилам проекта.',
    'Ничего не реализуй и не меняй код.',
  ].join(' ')
}

/** Read and parse a small JSON request body. */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

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

  /** Handle GET /api/sdd, GET /api/sdd/projects and POST /api/sdd/tasks/move. */
  async handleHttp(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const pathname = url.pathname.replace(/\/+$/, '')
      if (pathname.endsWith('/chat') || pathname.endsWith('/prompt')) {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        let body = null
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        const result = pathname.endsWith('/chat')
          ? await this.createChat(body?.sessionId ?? null, body ?? {})
          : await this.sendPrompt(body?.sessionId ?? null, body?.text)
        return json(res, result.ok ? 200 : 400, result)
      }
      if (pathname.endsWith('/tasks/move')) {
        if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
        let body = null
        try {
          body = await readJsonBody(req)
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
        const result = await this.moveTaskForSession(body?.sessionId ?? null, body ?? {})
        return json(res, result.ok ? 200 : 400, result)
      }
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (pathname.endsWith('/projects')) {
        return json(res, 200, { ok: true, projects: await this.portfolio() })
      }
      if (pathname !== '/api/sdd') {
        return json(res, 404, { ok: false, error: 'not-found' })
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

  /** Tool `sdd_projects`: portfolio rows. */
  async projects() {
    return { ok: true, projects: await this.portfolio() }
  }

  /**
   * Weekly digest for the session's project.
   * @param {any} exec
   * @param {number} [days]
   */
  async digest(exec, days) {
    const cwd = exec?.agent?.session?.header?.cwd
    const state = await this.ensureState(cwd)
    if (!state) return { ok: false, error: 'no-session', markdown: '' }
    const digest = await buildDigest({ project: state.project, state, days })
    return { ok: true, markdown: digestText(state, digest), digest }
  }

  /** Task board of the session's project. */
  async tasks(exec) {
    const cwd = exec?.agent?.session?.header?.cwd
    const state = await this.ensureState(cwd)
    if (!state) return { ok: false, error: 'no-session', tasks: null }
    return { ok: true, tasks: state.tasks }
  }

  /**
   * Move one task to another kanban column, rewriting only its status marker.
   * @param {string|null} cwd
   * @param {{ path?: string, line?: number|null, id?: string, status?: string }} request
   */
  async moveTaskForCwd(cwd, request) {
    const state = await this.ensureState(cwd)
    if (!state) return { ok: false, error: 'no-session' }
    const items = state.tasks?.items ?? []
    if (items.length === 0) return { ok: false, error: 'no-tasks' }
    const wantedLine = Number.isFinite(request?.line) ? request.line : null
    const item = items.find(
      (task) =>
        task.path === request?.path &&
        (wantedLine !== null ? task.line === wantedLine : String(task.id) === String(request?.id)),
    )
    if (!item) return { ok: false, error: 'task-not-found' }
    try {
      const result = await setTaskColumn({
        root: state.project.root,
        practice: state.practice,
        task: item,
        column: String(request?.status ?? ''),
      })
      this.invalidate(state.project.root)
      return { ok: true, ...result }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /** Tool `sdd_task_move`. */
  async moveTask(exec, request) {
    const cwd = exec?.agent?.session?.header?.cwd
    return this.moveTaskForCwd(cwd, request)
  }

  /**
   * Start a chat in the project for a task or a new feature (grilling).
   * The session is created on the host through the agent registry, so the
   * client does not need the wire API.
   * @param {string|null} sessionId - current session.
   * @param {{ kind?: 'task'|'feature', task?: { title?: string, id?: string, path?: string } }} request
   */
  async createChat(sessionId, request) {
    const cwd = await this.cwdForSession(sessionId)
    if (!cwd) return { ok: false, error: 'no-session' }
    const state = await this.ensureState(cwd)
    const root = state?.project?.root ?? cwd
    const kind = request?.kind === 'feature' ? 'feature' : 'task'

    let prompt
    if (kind === 'feature') {
      prompt = featurePrompt(state?.project?.features)
    } else {
      const task = request?.task ?? {}
      if (!task.title) return { ok: false, error: 'task-title-required' }
      const known = (state?.tasks?.items ?? []).some(
        (item) => item.path === task.path && String(item.id) === String(task.id),
      )
      if (!known) return { ok: false, error: 'task-not-found' }
      prompt = taskPrompt(task)
    }

    const agents = this.ctx?.get?.('agents')
    if (!agents?.create) return { ok: false, error: 'agents-unavailable' }
    // The live agent id may differ from the client-visible session id (forks,
    // resumes), so fall back to the only live agent in this project.
    const live = agents.list?.() ?? []
    const source =
      agents.get?.(sessionId) ??
      live.find((candidate) => candidate?.session?.header?.cwd === root) ??
      null
    if (!source) return { ok: false, error: 'agent-not-live' }
    const options = source.options ?? {}
    if (!options.provider || !options.model) return { ok: false, error: 'model-selection-unavailable' }
    const agentOptions = { provider: options.provider, model: options.model }
    if (options.reasoningEffort) agentOptions.reasoningEffort = options.reasoningEffort

    // The preset brings the tool set (files, search, shell). Without it the new
    // agent is composed with no tools at all.
    let presetId = source.session?.header?.agentPreset ?? null
    if (!presetId) {
      try {
        const preset = await this.ctx?.get?.('agentPresets')?.resolve?.()
        presetId = preset?.id ?? null
      } catch {
        presetId = null
      }
    }
    if (!presetId) return { ok: false, error: 'agent-preset-unavailable' }
    const presets = this.ctx?.get?.('agentPresets')
    if (!presets?.mount) return { ok: false, error: 'presets-unavailable' }

    const newSessionId = `session-${randomUUID()}`
    try {
      const handle = await agents.create({
        sessionId: newSessionId,
        meta: { cwd, agentPreset: presetId },
        agentOptions,
        // The preset's tool/prompt plugins are mounted in the factory's setup
        // hook; the header id alone composes nothing.
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, presetId)
        },
      })
      await this.attachToWorkspace(newSessionId, cwd, root)
      handle.agent.followup(chatMessage(prompt))
      return { ok: true, sessionId: newSessionId }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /** Attach a host-created session to the workspace that owns its directory. */
  async attachToWorkspace(sessionId, cwd, root) {
    const registry = this.ctx?.get?.('workspaceRegistry')
    if (!registry?.resolveByPath) return
    for (const candidate of [cwd, root]) {
      try {
        const workspace = await registry.resolveByPath(candidate)
        if (workspace?.attachSession) {
          await workspace.attachSession(sessionId)
          return
        }
      } catch {
        // The directory is not an owned workspace; leave the session as is.
      }
    }
  }

  /**
   * Send a natural-language instruction to a live session.
   * @param {string|null} sessionId
   * @param {string} text
   */
  async sendPrompt(sessionId, text) {
    if (!sessionId) return { ok: false, error: 'no-session' }
    if (!text || typeof text !== 'string') return { ok: false, error: 'text-required' }
    const agents = this.ctx?.get?.('agents')
    const live = agents?.list?.() ?? []
    const agent =
      agents?.get?.(sessionId) ??
      live.find((candidate) => candidate?.session?.header?.cwd === (this.cwdFor(sessionId) ?? '')) ??
      null
    if (!agent) return { ok: false, error: 'agent-not-live' }
    try {
      agent.followup(chatMessage(text))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  /** Move a task for the Web Client (session-scoped). */
  async moveTaskForSession(sessionId, request) {
    const cwd = await this.cwdForSession(sessionId)
    if (!cwd) return { ok: false, error: 'no-session' }
    return this.moveTaskForCwd(cwd, request)
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
            '/sdd digest [дней] — недельный дайджест',
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
      if (sub === 'digest') {
        const days = Number.parseInt(rest[0] ?? '', 10)
        const result = await this.digest(invocation, Number.isFinite(days) ? days : 7)
        return result.ok ? { kind: 'success', text: result.markdown } : { kind: 'error', text: 'Не удалось построить дайджест.' }
      }
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
