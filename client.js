window.__ModuleLoader__.load({
  id: 'dsh-sdd-compass',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ROUTE = 'api/sdd'
    const VERSION = '0.10.5'
    const POLL_MS = 20_000
    const C = {
      ok: '#22c55e',
      warn: '#f59e0b',
      bad: '#ef4444',
      muted: '#94a3b8',
      accent: '#5b8def',
    }

    const PHASES = ['idle', 'proposal', 'spec', 'design', 'tasks', 'apply', 'verify', 'archive']
    const PHASE_LABELS = {
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
    const PRACTICE_LABELS = {
      openspec: 'OpenSpec',
      scratch: 'Scratch',
      ssc: 'SSC',
      generic: 'план',
      unknown: 'не распознано',
    }
    const SEVERITY_ICON = { error: '✕', warn: '⚠', info: 'ℹ' }
    const SEVERITY_COLOR = { error: C.bad, warn: C.warn, info: C.muted }

    // ------------------------------------------------------------------
    // Shared store: the dock renders the summary, the overlay the details.
    // ------------------------------------------------------------------
    let state = {
      open: false,
      tab: 'now',
      status: 'idle',
      data: null,
      error: null,
      refreshing: false,
      projects: null,
      projectsLoading: false,
      moving: false,
      actionError: null,
      notice: null,
    }
    let currentSessionId = null
    const listeners = new Set()

    function setState(patch) {
      state = { ...state, ...patch }
      for (const listener of [...listeners]) listener()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    function useStore() {
      const [snapshot, setSnapshot] = React.useState(state)
      React.useEffect(() => subscribe(() => setSnapshot(state)), [])
      return snapshot
    }

    function flashNotice(text) {
      setState({ notice: text })
      setTimeout(() => setState({ notice: null }), 1600)
    }

    let inFlight = false
    async function load(sessionId, force) {
      if (inFlight) return
      inFlight = true
      if (force) setState({ refreshing: true })
      try {
        const url = new URL(ROUTE, document.baseURI)
        if (sessionId) url.searchParams.set('sessionId', sessionId)
        if (force) url.searchParams.set('refresh', '1')
        const response = await fetch(url, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json()
        if (!payload?.ok || !payload.state) {
          setState({ status: 'empty', data: null, error: null, refreshing: false })
          return
        }
        setState({ status: 'ok', data: payload.state, error: null, refreshing: false })
      } catch (error) {
        setState({ status: 'error', error: String(error?.message ?? error), refreshing: false })
      } finally {
        inFlight = false
      }
    }

    let projectsInFlight = false
    async function loadProjects() {
      if (projectsInFlight) return
      projectsInFlight = true
      setState({ projectsLoading: true })
      try {
        const response = await fetch(new URL('api/sdd/projects', document.baseURI), {
          headers: { accept: 'application/json' },
          credentials: 'same-origin',
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const payload = await response.json()
        setState({ projects: Array.isArray(payload?.projects) ? payload.projects : [], projectsLoading: false })
      } catch (error) {
        setState({ projects: [], projectsLoading: false, error: String(error?.message ?? error) })
      } finally {
        projectsInFlight = false
      }
    }

    async function moveTask(task, status) {
      setState({ moving: true, actionError: null })
      try {
        const response = await fetch(new URL('api/sdd/tasks/move', document.baseURI), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ sessionId: currentSessionId, path: task.path, line: task.line, id: task.id, status }),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || !payload?.ok) {
          setState({ moving: false, actionError: payload?.error ?? `HTTP ${response.status}` })
          return
        }
        setState({ moving: false, actionError: null })
        await load(currentSessionId, true)
      } catch (error) {
        setState({ moving: false, actionError: String(error?.message ?? error) })
      }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------
    const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

    function practiceLabel(practice) {
      return PRACTICE_LABELS[practice] ?? practice
    }

    function phaseProgress(phase) {
      const index = PHASES.indexOf(phase)
      if (index < 0) return { index: 0, total: PHASES.length, text: 'состояние не определено' }
      return { index, total: PHASES.length, text: `шаг ${index + 1} из ${PHASES.length}` }
    }

    function dotColor(data) {
      if (!data) return C.muted
      if (data.findings?.some((finding) => finding.severity === 'error')) return C.bad
      if (data.findings?.some((finding) => finding.severity === 'warn')) return C.warn
      if (data.phase === 'archive') return C.ok
      if (data.phase === 'idle' || data.phase === 'unknown') return C.muted
      return C.accent
    }

    function warnCount(data) {
      return (data?.findings ?? []).filter((finding) => finding.severity === 'warn' || finding.severity === 'error').length
    }

    function daysText(days) {
      if (days === null || days === undefined) return '—'
      return `${days} дн`
    }

    function truncateMiddle(value, max = 46) {
      const text = String(value ?? '')
      if (text.length <= max) return text
      const head = Math.ceil((max - 1) * 0.55)
      const tail = max - 1 - head
      return `${text.slice(0, head)}…${text.slice(-tail)}`
    }

    function joinPath(root, rel) {
      const sep = String(root).includes('\\') ? '\\' : '/'
      const base = String(root).replace(/[\\/]+$/, '')
      const tail = String(rel).replace(/^[\\/]+/, '').split(/[\\/]+/).join(sep)
      return `${base}${sep}${tail}`
    }

    function shortTaskTitle(text) {
      const clean = String(text ?? '').replace(/\s+/g, ' ').trim()
      const head = clean.split(/(?:Проверка:|\.\s)/)[0]
      const base = head.length >= 20 ? head : clean
      return base.length > 110 ? `${base.slice(0, 108).trimEnd()}…` : base
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    const chip = (extra) => ({
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '1px 8px',
      borderRadius: 999,
      fontSize: 10,
      lineHeight: '16px',
      background: 'rgba(127,127,127,0.14)',
      whiteSpace: 'nowrap',
      ...extra,
    })

    const button = (extra) => ({
      padding: '6px 12px',
      borderRadius: 8,
      cursor: 'pointer',
      fontSize: 12,
      border: '1px solid rgba(127,127,127,0.35)',
      background: 'transparent',
      color: 'inherit',
      ...extra,
    })

    const primaryButton = (extra) =>
      button({
        border: '1px solid rgba(91,141,239,0.7)',
        background: 'rgba(91,141,239,0.16)',
        fontWeight: 600,
        ...extra,
      })

    function Section({ title, count, children, action }) {
      return h(
        'div',
        { style: { marginTop: 14 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 } },
          h('div', { style: { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.55 } }, title),
          typeof count === 'number' ? h('span', { style: chip() }, String(count)) : null,
          h('span', { style: { flex: 1 } }),
          action ?? null,
        ),
        children,
      )
    }

    function Row({ label, value, color, monoValue }) {
      return h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: '112px 1fr', gap: 8, padding: '2px 0', fontSize: 12 } },
        h('span', { style: { opacity: 0.55 } }, label),
        h('span', { style: { color, fontFamily: monoValue ? mono : undefined, wordBreak: 'break-word' } }, value),
      )
    }

    // ------------------------------------------------------------------
    // Dock: one compact line, click opens the panel
    // ------------------------------------------------------------------
    function SddDock(props) {
      const snapshot = useStore()

      React.useEffect(() => {
        currentSessionId = props.sessionId ?? null
        void load(currentSessionId, false)
        const timer = setInterval(() => void load(currentSessionId, false), POLL_MS)
        return () => clearInterval(timer)
      }, [props.sessionId])

      const data = snapshot.data
      if (snapshot.status === 'error') {
        return h(
          'div',
          {
            style: { fontSize: 11, lineHeight: '16px', color: C.bad, cursor: 'pointer' },
            title: `SDD: ${snapshot.error}`,
            onClick: () => setState({ open: true, tab: 'now' }),
          },
          'SDD: недоступно',
        )
      }
      if (!data || data.phase === 'idle' || data.phase === 'unknown' || data.practice === 'unknown') return null

      const tasks = data.change?.tasks
      const warn = warnCount(data)
      return h(
        'div',
        {
          role: 'status',
          'aria-label': 'SDD-компас',
          title: [
            data.project?.name ?? '',
            `${practiceLabel(data.practice)} · ${data.phaseLabel}`,
            data.next?.label ? `Дальше: ${data.next.label}` : '',
            'клик — подробности',
          ]
            .filter(Boolean)
            .join('\n'),
          onClick: () => setState({ open: true, tab: 'now' }),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 11,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
            cursor: 'pointer',
            justifyContent: 'center',
            padding: '2px 0',
          },
        },
        h('span', { style: { opacity: 0.55, fontWeight: 600 } }, 'SDD'),
        h('span', { style: { color: dotColor(data) } }, '●'),
        h('span', null, data.phaseLabel),
        tasks && tasks.total > 0 ? h('span', { style: { opacity: 0.65 } }, `${tasks.done}/${tasks.total}`) : null,
        warn > 0 ? h('span', { style: { color: C.warn } }, `⚠ ${warn}`) : null,
      )
    }

    // ------------------------------------------------------------------
    // Now tab: actions first, facts second
    // ------------------------------------------------------------------
    function FindingRow({ finding, onCopyCommand, onOpen }) {
      const action =
        finding.rule === 'archive.pending'
          ? h(
              'button',
              { type: 'button', style: button({ padding: '2px 8px', fontSize: 10 }), onClick: () => onCopyCommand() },
              'Команда',
            )
          : finding.paths?.length
            ? h(
                'button',
                { type: 'button', style: button({ padding: '2px 8px', fontSize: 10 }), onClick: () => onOpen(finding.paths[0]) },
                'Открыть',
              )
            : null
      return h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            padding: '4px 0',
            fontSize: 12,
            lineHeight: '17px',
            color: finding.severity === 'info' ? 'inherit' : SEVERITY_COLOR[finding.severity],
          },
        },
        h('span', { style: { flex: '0 0 auto' } }, SEVERITY_ICON[finding.severity] ?? '·'),
        h('span', { style: { flex: 1 } }, finding.message),
        action,
      )
    }

    function NowTab({ data, onCommand, onCopyCommand, onOpen, onStartTask, onTasks, onFeature }) {
      const change = data.change
      const findings = (data.findings ?? []).slice(0, 3)
      const progress = phaseProgress(data.phase)
      const tasks = data.tasks
      const nextCommand = data.next?.command
      const todoTask = tasks?.items?.find((task) => task.kanban === 'todo')

      const actions = []
      if (data.phase === 'verify' && nextCommand) {
        actions.push(['archive', 'Заархивировать', () => onCopyCommand(nextCommand)])
      }
      if (data.phase === 'apply' && todoTask) {
        actions.push(['start', 'Начать задачу', () => onStartTask(todoTask)])
      }
      if (data.phase === 'idle' || data.phase === 'archive') {
        actions.push(['feature', 'Новая задача', () => onFeature()])
      }
      actions.push(['next', 'Дальше', () => onCommand('Вызови sdd_status и коротко объясни, что делать дальше по SDD.')])
      actions.push(['check', 'Проверить', () => onCommand('Вызови sdd_check и покажи замечания по проекту.')])
      if (tasks?.items?.length) actions.push(['tasks', 'Задачи', onTasks])

      return h(
        'div',
        null,
        h(
          'div',
          { style: { fontSize: 12, lineHeight: '18px' } },
          h('span', { style: { fontWeight: 600 } }, data.project?.name ?? 'проект'),
          h('span', { style: { opacity: 0.5 } }, ' · '),
          h('span', null, data.phaseLabel),
          h('span', { style: { opacity: 0.5 } }, ` · ${progress.text}`),
          change ? h('span', { style: { opacity: 0.65, fontFamily: mono } }, ` · ${change.id}`) : null,
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 } },
          actions.map(([id, label, onClick]) =>
            h('button', { key: id, type: 'button', style: id === 'archive' || id === 'start' ? primaryButton() : button(), onClick: () => void onClick() }, label),
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 } },
          change?.tasks?.total ? h('span', { style: chip() }, `задачи ${change.tasks.done}/${change.tasks.total}`) : null,
          change?.questions?.total ? h('span', { style: chip() }, `вопросы ${change.questions.total}`) : null,
          warnCount(data) > 0 ? h('span', { style: chip({ color: C.warn }) }, `⚠ ${warnCount(data)}`) : null,
        ),
        h(
          Section,
          { title: 'Замечания', count: (data.findings ?? []).length },
          findings.length === 0
            ? h('div', { style: { fontSize: 12, opacity: 0.65 } }, 'Всё чисто — замечаний нет.')
            : findings.map((finding, index) =>
                h(FindingRow, {
                  key: `${finding.rule}-${index}`,
                  finding,
                  onCopyCommand: () => onCopyCommand(nextCommand ?? data.next?.command ?? ''),
                  onOpen: (path) => onOpen(path),
                }),
              ),
        ),
        data.rule ? h('div', { style: { fontSize: 11, opacity: 0.45, marginTop: 12 } }, data.rule) : null,
      )
    }

    // ------------------------------------------------------------------
    // Tasks tab
    // ------------------------------------------------------------------
    const BOARD_COLUMNS = [
      ['todo', 'Очередь'],
      ['doing', 'В работе'],
      ['review', 'Проверка'],
      ['done', 'Готово'],
    ]

    function taskActions(task, writable, practice) {
      const actions = []
      if (practice === 'openspec') {
        if (task.kanban === 'done') {
          actions.push(['todo', 'Вернуть'])
        } else {
          if (task.kanban === 'todo') actions.push(['doing', 'Начать'])
          actions.push(['done', 'Готово'])
          if (task.kanban === 'doing') actions.push(['todo', 'Вернуть'])
        }
        return actions
      }
      if (task.kanban !== 'doing' && writable.includes('doing')) actions.push(['doing', 'Начать'])
      if (task.kanban !== 'review' && task.kanban !== 'done' && writable.includes('review')) actions.push(['review', 'Проверка'])
      if (task.kanban !== 'done' && writable.includes('done')) actions.push(['done', 'Готово'])
      if (task.kanban !== 'todo') actions.push(['todo', 'Вернуть'])
      return actions
    }

    function TaskCard({ task, writable, practice, moving, onStart, onOpenFile }) {
      const actions = taskActions(task, writable, practice)
      return h(
        'div',
        {
          title: task.title,
          style: {
            padding: '6px 8px',
            borderRadius: 8,
            background: 'rgba(127,127,127,0.10)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          },
        },
        h(
          'div',
          {
            style: {
              fontSize: 11,
              lineHeight: '15px',
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            },
          },
          shortTaskTitle(task.title),
        ),
        h(
          'div',
          { style: { fontSize: 9, opacity: 0.5, fontFamily: mono, wordBreak: 'break-all' } },
          `${task.id}${task.blockedBy ? ` · блок: ${task.blockedBy}` : ''}`,
        ),
        h(
          'div',
          { style: { display: 'flex', gap: 4, flexWrap: 'wrap' } },
          actions.map(([status, label]) =>
            h(
              'button',
              {
                key: status,
                type: 'button',
                disabled: moving,
                style: button({ padding: '2px 8px', fontSize: 10 }),
                onClick: () => (status === 'doing' ? void onStart(task) : void moveTask(task, status)),
              },
              label,
            ),
          ),
          task.path
            ? h(
                'button',
                { type: 'button', style: button({ padding: '2px 8px', fontSize: 10 }), onClick: () => onOpenFile(task.path) },
                'Файл',
              )
            : null,
        ),
      )
    }

    function TasksTab({ data, moving, actionError, onStart, onOpenFile }) {
      const tasks = data.tasks
      if (!tasks?.items?.length) {
        return h(
          'div',
          { style: { fontSize: 12, opacity: 0.65, padding: '12px 0' } },
          'Задач нет: у активного изменения не найдено тикетов или чекбоксов.',
        )
      }
      return h(
        'div',
        null,
        actionError ? h('div', { style: { fontSize: 11, color: C.bad, marginBottom: 6 } }, actionError) : null,
        h(
          'div',
          { style: { display: 'flex', gap: 10, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 4 } },
          BOARD_COLUMNS.map(([column, label]) => {
            const items = tasks.items.filter((task) => task.kanban === column)
            return h(
              'div',
              { key: column, style: { flex: '1 1 200px', minWidth: 200, display: 'flex', flexDirection: 'column', gap: 6 } },
              h(
                'div',
                { style: { display: 'flex', gap: 6, alignItems: 'baseline' } },
                h('span', { style: { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.55 } }, label),
                h('span', { style: chip() }, String(items.length)),
              ),
              items.length === 0
                ? h('div', { style: { fontSize: 10, opacity: 0.3 } }, '—')
                : items.map((task) =>
                    h(TaskCard, {
                      key: `${task.path}:${task.line ?? task.id}`,
                      task,
                      writable: tasks.writable ?? [],
                      practice: tasks.practice,
                      moving,
                      onStart,
                      onOpenFile,
                    }),
                  ),
            )
          }),
        ),
      )
    }

    // ------------------------------------------------------------------
    // More tab: documents, projects, metrics
    // ------------------------------------------------------------------
    function MoreTab({ data, projects, projectsLoading, onOpenPath, onRefreshProjects }) {
      const docs = data.docs ?? []
      const snapshot = data.stats?.snapshot
      const history = data.stats?.history
      const trace = data.trace
      return h(
        'div',
        null,
        h(
          Section,
          {
            title: 'Документы',
            count: docs.length,
            action: h('button', { type: 'button', style: button({ padding: '2px 8px', fontSize: 10 }), onClick: () => onRefreshProjects() }, 'Обновить'),
          },
          docs.length === 0
            ? h('div', { style: { fontSize: 11, opacity: 0.6 } }, 'Документы не найдены.')
            : docs.map((doc) =>
                h(
                  'div',
                  { key: doc.path, style: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0', fontSize: 12 } },
                  h('span', { style: { fontWeight: 600, wordBreak: 'break-all' } }, doc.path.split('/').pop() ?? doc.path),
                  h('span', { style: { fontSize: 10, opacity: 0.5 } }, doc.why),
                  h('span', { style: { flex: 1 } }),
                  h(
                    'button',
                    { type: 'button', style: button({ padding: '2px 8px', fontSize: 10 }), onClick: () => onOpenPath(doc.path) },
                    'Открыть',
                  ),
                ),
              ),
        ),
        h(
          Section,
          { title: 'Проекты', count: projects?.length ?? 0 },
          !projects?.length
            ? h('div', { style: { fontSize: 11, opacity: 0.6 } }, projectsLoading ? 'Собираю проекты…' : 'Проекты не найдены.')
            : projects.map((row) =>
                h(
                  'div',
                  { key: row.path ?? row.name, style: { display: 'flex', gap: 6, alignItems: 'baseline', padding: '2px 0', fontSize: 12 } },
                  h('span', { style: { fontWeight: 600 } }, row.name),
                  h('span', { style: chip() }, practiceLabel(row.practice)),
                  h('span', { style: { opacity: 0.7 } }, row.phaseLabel),
                  row.warnings > 0 ? h('span', { style: { color: C.warn } }, `⚠${row.warnings}`) : null,
                  h('span', { style: { flex: 1 } }),
                  h(
                    'button',
                    { type: 'button', style: button({ padding: '2px 8px', fontSize: 10 }), onClick: () => onOpenPath(row.path, true) },
                    'Папка',
                  ),
                ),
              ),
        ),
        h(
          Section,
          { title: 'Метрики' },
          history?.available
            ? h(
                'div',
                null,
                h(Row, {
                  label: 'Цикл',
                  value: history.cycleMedianDays !== null ? `${history.cycleMedianDays} дн медиана · p90 ${history.cycleP90Days} · n=${history.sample}` : 'мало данных',
                }),
                history.archiveRate !== null ? h(Row, { label: 'До архива', value: `${Math.round(history.archiveRate * 100)}%` }) : null,
                history.drift7d !== null ? h(Row, { label: 'Дрейф 7 дн', value: `${history.drift7d} файл(ов)` }) : null,
              )
            : h('div', { style: { fontSize: 11, opacity: 0.6 } }, history?.reason ?? 'История недоступна.'),
          trace ? h(Row, { label: 'Аннотации', value: `${trace.files} файл(ов)${trace.requirementIds ? ` · ${trace.covered}/${trace.requirementIds}` : ''}` }) : null,
          snapshot?.stuck?.length
            ? h(
                'div',
                { style: { marginTop: 6 } },
                h('div', { style: { fontSize: 10, opacity: 0.5, marginBottom: 2 } }, 'Застряло'),
                snapshot.stuck.map((item) => h('div', { key: item.id, style: { fontSize: 11, color: C.warn } }, `${item.id} — ${item.days} дн`)),
              )
            : null,
        ),
      )
    }

    // ------------------------------------------------------------------
    // Panel shell
    // ------------------------------------------------------------------
    function Panel({ startTask, startFeature, sendPrompt, openPath }) {
      const snapshot = useStore()

      React.useEffect(() => {
        if (snapshot.open && currentSessionId) void load(currentSessionId, true)
      }, [snapshot.open, currentSessionId])

      React.useEffect(() => {
        if (snapshot.open && snapshot.tab === 'more' && !snapshot.projects && !snapshot.projectsLoading) void loadProjects()
      }, [snapshot.open, snapshot.tab, snapshot.projects, snapshot.projectsLoading])

      if (!snapshot.open) return null
      const data = snapshot.data
      const root = data?.project?.root ?? null
      const close = () => setState({ open: false })

      const guard = async (label, task) => {
        setState({ actionError: null })
        try {
          await task()
        } catch (error) {
          setState({ actionError: `${label}: ${String(error?.message ?? error)}` })
        }
      }

      const onCommand = (text) =>
        guard(text, async () => {
          await sendPrompt(text)
          setTimeout(() => void load(currentSessionId, true), 400)
        })
      const onCopyCommand = (command) =>
        guard('Копирование', async () => {
          if (!command) throw new Error('команды нет')
          if (!(await copyText(command))) throw new Error('буфер обмена недоступен')
          flashNotice('Команда скопирована')
        })
      const onOpen = (path, absolute = false) =>
        guard('Открытие', async () => {
          if (!path) throw new Error('путь не найден')
          await openPath(absolute ? path : joinPath(root, path))
        })
      const onStartTask = (task) =>
        guard('Старт задачи', async () => {
          await moveTask(task, 'doing')
          await startTask(task)
        })
      const onFeature = () => guard('Новая задача', () => startFeature())

      const tabs = [
        ['now', 'Сейчас'],
        ['tasks', 'Задачи'],
        ['more', 'Ещё'],
      ]

      const body = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 900, minWidth: 300, boxSizing: 'border-box' } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('div', { style: { fontSize: 13, fontWeight: 600 } }, 'SDD-компас'),
          h('span', { style: { fontSize: 9, opacity: 0.35, fontFamily: mono } }, `v${VERSION}`),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', style: primaryButton({ padding: '4px 10px' }), onClick: () => void onFeature() }, '+ Задача'),
          h(
            'button',
            { type: 'button', onClick: close, title: 'Закрыть', style: { border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 16, opacity: 0.6, lineHeight: 1 } },
            '×',
          ),
        ),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 4, borderBottom: '1px solid rgba(127,127,127,0.22)', paddingBottom: 6 } },
          tabs.map(([id, label]) =>
            h(
              'button',
              {
                key: id,
                type: 'button',
                onClick: () => setState({ tab: id }),
                style: {
                  border: 'none',
                  borderRadius: 999,
                  padding: '5px 11px',
                  fontSize: 12,
                  cursor: 'pointer',
                  color: 'inherit',
                  background: snapshot.tab === id ? 'rgba(91,141,239,0.18)' : 'transparent',
                  fontWeight: snapshot.tab === id ? 600 : 400,
                  whiteSpace: 'nowrap',
                },
              },
              label,
            ),
          ),
        ),
        snapshot.actionError ? h('div', { style: { fontSize: 11, color: C.bad } }, snapshot.actionError) : null,
        snapshot.notice ? h('div', { style: { fontSize: 11, color: C.ok } }, snapshot.notice) : null,
        !data
          ? h(
              'div',
              { style: { fontSize: 12, opacity: 0.65, padding: '14px 0' } },
              snapshot.status === 'error' ? `Не удалось получить состояние: ${snapshot.error}` : 'Состояние ещё не вычислено — открой проект и напиши сообщение.',
            )
          : snapshot.tab === 'now'
            ? h(NowTab, {
                data,
                onCommand,
                onCopyCommand,
                onOpen,
                onStartTask,
                onTasks: () => setState({ tab: 'tasks' }),
                onFeature,
              })
            : snapshot.tab === 'tasks'
              ? h(TasksTab, {
                  data,
                  moving: snapshot.moving,
                  actionError: null,
                  onStart: onStartTask,
                  onOpenFile: (path) => onOpen(path),
                })
              : h(MoreTab, {
                  data,
                  projects: snapshot.projects,
                  projectsLoading: snapshot.projectsLoading,
                  onOpenPath: (path, absolute = false) => onOpen(path, absolute),
                  onRefreshProjects: () => void loadProjects(),
                }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 6, paddingTop: 8, borderTop: '1px solid rgba(127,127,127,0.18)', alignItems: 'center' } },
          h('button', { type: 'button', onClick: () => void load(currentSessionId, true), disabled: snapshot.refreshing, style: button() }, snapshot.refreshing ? 'Обновляю…' : 'Обновить'),
          h('span', { style: { flex: 1 } }),
          data?.project?.root
            ? h('span', { title: data.project.root, style: { fontSize: 9, opacity: 0.4, fontFamily: mono, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, truncateMiddle(data.project.root, 38))
            : null,
        ),
      )

      return h(
        'div',
        {
          onClick: close,
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.45)',
            padding: 12,
          },
        },
        h(
          'div',
          {
            onClick: (event) => event.stopPropagation(),
            style: {
              background: 'Canvas',
              color: 'CanvasText',
              border: '1px solid rgba(127,127,127,0.35)',
              borderRadius: 12,
              padding: 16,
              width: 'min(900px, 96vw)',
              maxHeight: '88vh',
              overflow: 'auto',
              boxSizing: 'border-box',
            },
          },
          body,
        ),
      )
    }

    // ------------------------------------------------------------------
    // Registration
    // ------------------------------------------------------------------
    return {
      // The host half owns session creation; the client only needs slots plus
      // session and workspace navigation.
      inject: ['slots', 'sessions', 'workspaces'],
      apply(ctx) {
        const sessionsOf = () => ctx.sessions
        const workspacesOf = () => ctx.workspaces

        async function openSessionWhenListed(sessionId) {
          const sessions = sessionsOf()
          const deadline = Date.now() + 5000
          while (Date.now() < deadline) {
            const snapshot = sessions?.list?.getSnapshot?.()
            if (snapshot?.items?.some((item) => item.sessionId === sessionId)) break
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          try {
            sessions?.open?.(sessionId)
          } catch {
            // The session exists even when navigation lags.
          }
        }

        /**
         * Ask the host half to create a session for a task or a new feature.
         * The host owns the agent registry, so the client needs no wire API.
         */
        async function startChat(request) {
          const response = await fetch(new URL('api/sdd/chat', document.baseURI), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ sessionId: currentSessionId, ...request }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          if (payload.sessionId) await openSessionWhenListed(payload.sessionId)
          return payload.sessionId
        }

        /** Send one natural-language instruction to the current live session. */
        async function sendPrompt(text) {
          const response = await fetch(new URL('api/sdd/prompt', document.baseURI), {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ sessionId: currentSessionId, text }),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || !payload?.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        }

        async function openPath(absolute) {
          const workspaces = workspacesOf()
          if (!workspaces?.openPath) throw new Error('открытие путей недоступно')
          await workspaces.openPath(absolute)
        }

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'sdd-compass', order: 6 }, SddDock),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'sdd-compass.panel',
              inject: () => ({
                startTask: (task) => startChat({ kind: 'task', task }),
                startFeature: () => startChat({ kind: 'feature' }),
                sendPrompt,
                openPath,
              }),
            },
            Panel,
          ),
        )
      },
    }
  },
})
