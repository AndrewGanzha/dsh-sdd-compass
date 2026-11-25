window.__ModuleLoader__.load({
  id: 'dsh-sdd-compass',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // Optional host component library; the panel falls back to a plain overlay.
    let primitives = null
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = null
    }

    const ROUTE = 'api/sdd'
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
      tab: 'status',
      status: 'idle',
      data: null,
      error: null,
      refreshing: false,
      projects: null,
      projectsLoading: false,
      moving: false,
      moveError: null,
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

    // ------------------------------------------------------------------
    // Task board: move one task by rewriting its status marker
    // ------------------------------------------------------------------
    async function moveTask(task, status) {
      setState({ moving: true, moveError: null })
      try {
        const response = await fetch(new URL('api/sdd/tasks/move', document.baseURI), {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            sessionId: currentSessionId,
            path: task.path,
            line: task.line,
            id: task.id,
            status,
          }),
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || !payload?.ok) {
          setState({ moving: false, moveError: payload?.error ?? `HTTP ${response.status}` })
          return
        }
        setState({ moving: false, moveError: null })
        await load(currentSessionId, true)
      } catch (error) {
        setState({ moving: false, moveError: String(error?.message ?? error) })
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

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    // ------------------------------------------------------------------
    // Shared bits
    // ------------------------------------------------------------------
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
      padding: '6px 14px',
      borderRadius: 8,
      cursor: 'pointer',
      fontSize: 12,
      border: '1px solid rgba(127,127,127,0.35)',
      background: 'transparent',
      color: 'inherit',
      ...extra,
    })

    function PhaseBar({ phase }) {
      const { index, total } = phaseProgress(phase)
      return h(
        'div',
        { style: { margin: '10px 0 2px' } },
        h(
          'div',
          { style: { display: 'flex', gap: 3 } },
          PHASES.map((item, position) =>
            h('span', {
              key: item,
              title: PHASE_LABELS[item] ?? item,
              style: {
                flex: 1,
                height: 4,
                borderRadius: 2,
                background: position < index ? C.ok : position === index ? C.accent : 'rgba(127,127,127,0.22)',
              },
            }),
          ),
        ),
        h(
          'div',
          { style: { marginTop: 6, fontSize: 10, opacity: 0.6 } },
          `${phaseProgress(phase).text} · ${PHASE_LABELS[phase] ?? phase}`,
        ),
      )
    }

    function Section({ title, count, children, action }) {
      return h(
        'div',
        { style: { marginTop: 16 } },
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

    function FindingRow({ finding }) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 8,
            padding: '4px 0',
            fontSize: 12,
            lineHeight: '17px',
            color: finding.severity === 'info' ? 'inherit' : SEVERITY_COLOR[finding.severity],
          },
        },
        h('span', { style: { flex: '0 0 auto' } }, SEVERITY_ICON[finding.severity] ?? '·'),
        h('span', null, finding.message),
      )
    }

    function DocRow({ doc }) {
      const slash = doc.path.lastIndexOf('/')
      const dir = slash > 0 ? doc.path.slice(0, slash + 1) : ''
      const name = slash > 0 ? doc.path.slice(slash + 1) : doc.path
      return h(
        'div',
        { style: { padding: '3px 0', fontSize: 12, lineHeight: '17px' } },
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600, wordBreak: 'break-all' } }, name),
          h('span', { style: chip() }, doc.why),
        ),
        dir ? h('div', { title: doc.path, style: { fontSize: 10, opacity: 0.5, fontFamily: mono, wordBreak: 'break-all' } }, truncateMiddle(dir, 52)) : null,
      )
    }

    function NextCard({ next }) {
      const [copied, setCopied] = React.useState(false)
      const command = next.command
      return h(
        'div',
        {
          style: {
            marginTop: 12,
            padding: '10px 12px',
            borderRadius: 10,
            background: 'rgba(91,141,239,0.10)',
            borderLeft: `3px solid ${C.accent}`,
          },
        },
        h('div', { style: { fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.6, opacity: 0.6 } }, 'Что дальше'),
        h('div', { style: { fontSize: 13, fontWeight: 600, marginTop: 2 } }, next.label),
        next.hint && next.hint !== command ? h('div', { style: { fontSize: 11, opacity: 0.7, marginTop: 3 } }, next.hint) : null,
        command
          ? h(
              'div',
              { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' } },
              h(
                'code',
                {
                  style: {
                    flex: '1 1 200px',
                    fontFamily: mono,
                    fontSize: 11,
                    padding: '5px 8px',
                    borderRadius: 6,
                    background: 'rgba(127,127,127,0.16)',
                    wordBreak: 'break-all',
                  },
                },
                command,
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: button({ padding: '4px 10px' }),
                  onClick: async () => {
                    if (await copyText(command)) {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1500)
                    }
                  },
                },
                copied ? 'Скопировано' : 'Копировать',
              ),
            )
          : null,
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
            onClick: () => setState({ open: true, tab: 'status' }),
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
          onClick: () => setState({ open: true, tab: 'status' }),
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
    // Panel tabs
    // ------------------------------------------------------------------
    function StatusTab({ data }) {
      const change = data.change
      const findings = data.findings ?? []
      const docs = data.docs ?? []
      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 14, fontWeight: 600 } }, data.project?.name ?? 'проект'),
          h('span', { style: chip() }, practiceLabel(data.practice)),
          data.project?.branch ? h('span', { style: { fontSize: 10, opacity: 0.5, fontFamily: mono } }, data.project.branch) : null,
        ),
        h('div', { style: { fontSize: 12, opacity: 0.75, marginTop: 2 } }, data.phaseLabel),
        h(PhaseBar, { phase: data.phase }),
        data.next ? h(NextCard, { next: data.next }) : null,
        change
          ? h(
              Section,
              { title: 'Изменение' },
              h(Row, { label: 'ID', value: change.id, monoValue: true }),
              change.title && change.title !== change.id ? h(Row, { label: 'Название', value: change.title }) : null,
              h(Row, { label: 'Обновлено', value: daysText(change.updatedDays) }),
              change.tasks && change.tasks.total > 0
                ? h(Row, { label: 'Задачи', value: `${change.tasks.done}/${change.tasks.total}` })
                : null,
              change.questions?.total
                ? h(Row, {
                    label: 'Вопросы',
                    value: change.questions.blockers
                      ? `${change.questions.total} (блокирующих ${change.questions.blockers})`
                      : String(change.questions.total),
                  })
                : null,
              data.links && (data.links.impact > 0 || data.links.changed > 0)
                ? h(Row, {
                    label: 'Impact',
                    value: `${data.links.impact} · изменено ${data.links.changed} · вне ${data.links.untrackedCount}`,
                  })
                : null,
            )
          : h('div', { style: { fontSize: 12, opacity: 0.65, marginTop: 12 } }, 'Активных изменений нет.'),
        h(
          Section,
          { title: 'Замечания', count: findings.length },
          findings.length === 0
            ? h('div', { style: { fontSize: 12, opacity: 0.65 } }, 'Всё чисто — замечаний нет.')
            : findings.map((finding, index) => h(FindingRow, { key: `${finding.rule}-${index}`, finding })),
        ),
        docs.length > 0
          ? h(
              Section,
              {
                title: 'Документы',
                count: docs.length,
                action: h(
                  'button',
                  { type: 'button', style: button({ padding: '2px 8px', fontSize: 10 }), onClick: () => setState({ tab: 'docs' }) },
                  'Все →',
                ),
              },
              docs.slice(0, 3).map((doc) => h(DocRow, { key: doc.path, doc })),
              docs.length > 3
                ? h('div', { style: { fontSize: 10, opacity: 0.5, marginTop: 4 } }, `ещё ${docs.length - 3} во вкладке «Документы»`)
                : null,
            )
          : null,
        data.rule ? h('div', { style: { fontSize: 11, opacity: 0.6, marginTop: 12 } }, data.rule) : null,
      )
    }

    const BOARD_COLUMNS = [
      ['todo', 'Очередь'],
      ['doing', 'В работе'],
      ['review', 'Проверка'],
      ['done', 'Готово'],
    ]

    function taskActions(task, writable, practice) {
      const actions = []
      if (practice === 'openspec') {
        actions.push(task.kanban === 'done' ? ['todo', 'Вернуть'] : ['done', 'Готово'])
        return actions
      }
      if (task.kanban !== 'doing' && writable.includes('doing')) actions.push(['doing', 'Взять'])
      if (task.kanban !== 'review' && task.kanban !== 'done' && writable.includes('review')) actions.push(['review', 'Проверка'])
      if (task.kanban !== 'done' && writable.includes('done')) actions.push(['done', 'Готово'])
      if (task.kanban !== 'todo') actions.push(['todo', 'Вернуть'])
      return actions
    }

    function TaskCard({ task, writable, practice, moving }) {
      const actions = taskActions(task, writable, practice)
      return h(
        'div',
        {
          style: {
            padding: '6px 8px',
            borderRadius: 8,
            background: 'rgba(127,127,127,0.10)',
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          },
        },
        h('div', { style: { fontSize: 12, lineHeight: '16px' } }, task.title),
        h(
          'div',
          { style: { fontSize: 9, opacity: 0.5, fontFamily: mono, wordBreak: 'break-all' } },
          `${task.id}${task.blockedBy ? ` · блок: ${task.blockedBy}` : ''}`,
        ),
        actions.length > 0
          ? h(
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
                    onClick: () => void moveTask(task, status),
                  },
                  label,
                ),
              ),
            )
          : null,
      )
    }

    function TasksTab({ data, moving, moveError }) {
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
        moveError ? h('div', { style: { fontSize: 11, color: C.bad, marginBottom: 6 } }, moveError) : null,
        h(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 4 } },
          BOARD_COLUMNS.map(([column, label]) => {
            const items = tasks.items.filter((task) => task.kanban === column)
            return h(
              'div',
              { key: column, style: { flex: '1 1 150px', minWidth: 150, display: 'flex', flexDirection: 'column', gap: 6 } },
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
                    }),
                  ),
            )
          }),
        ),
      )
    }

    function StatsTab({ data }) {
      const snapshot = data.stats?.snapshot
      const history = data.stats?.history
      const trace = data.trace
      const links = data.links
      return h(
        'div',
        null,
        h(
          Section,
          { title: 'Сейчас' },
          h(Row, { label: 'Фаза', value: `${data.phaseLabel}${snapshot?.daysInPhase !== null && snapshot?.daysInPhase !== undefined ? ` · ${snapshot.daysInPhase} дн` : ''}` }),
          snapshot ? h(Row, { label: 'В работе', value: `${snapshot.wip} изменени(й)` }) : null,
          snapshot?.tasks ? h(Row, { label: 'Задачи', value: `${snapshot.tasks.done}/${snapshot.tasks.total}` }) : null,
          snapshot?.questions?.total
            ? h(Row, {
                label: 'Вопросы',
                value: snapshot.questions.blockers
                  ? `${snapshot.questions.total} (блокирующих ${snapshot.questions.blockers})`
                  : String(snapshot.questions.total),
              })
            : null,
          snapshot?.stuck?.length
            ? h(
                'div',
                { style: { marginTop: 6 } },
                h('div', { style: { fontSize: 10, opacity: 0.5, marginBottom: 2 } }, 'Застряло'),
                snapshot.stuck.map((item) =>
                  h(
                    'div',
                    { key: item.id, style: { fontSize: 11, color: C.warn, padding: '1px 0' } },
                    `${item.id} — ${item.days} дн (${PHASE_LABELS[item.phase] ?? item.phase})`,
                  ),
                ),
              )
            : null,
        ),
        h(
          Section,
          { title: 'История' },
          history?.available
            ? h(
                'div',
                null,
                history.cycleMedianDays !== null
                  ? h(Row, { label: 'Цикл', value: `${history.cycleMedianDays} дн медиана · p90 ${history.cycleP90Days} · n=${history.sample}` })
                  : h(Row, { label: 'Цикл', value: 'мало данных' }),
                history.archiveRate !== null ? h(Row, { label: 'До архива', value: `${Math.round(history.archiveRate * 100)}%` }) : null,
                history.drift7d !== null ? h(Row, { label: 'Дрейф 7 дн', value: `${history.drift7d} файл(ов)` }) : null,
              )
            : h('div', { style: { fontSize: 11, opacity: 0.65 } }, history?.reason ?? 'История недоступна.'),
        ),
        trace || links
          ? h(
              Section,
              { title: 'Связи' },
              trace
                ? h(Row, {
                    label: 'Аннотации',
                    value: `${trace.files} файл(ов)${trace.requirementIds ? ` · требования ${trace.covered}/${trace.requirementIds}` : ''} · связь ${trace.linkedChange}`,
                  })
                : null,
              links
                ? h(Row, {
                    label: 'Impact',
                    value: `${links.impact} объявлено · ${links.changedInImpact} совпало · ${links.untrackedCount} вне`,
                  })
                : null,
            )
          : null,
      )
    }

    function DocsTab({ data }) {
      const docs = data.docs ?? []
      if (docs.length === 0) {
        return h(
          'div',
          { style: { fontSize: 12, opacity: 0.65, padding: '12px 0' } },
          'Документы не найдены. Добавь docs/ или артефакты изменения — они появятся здесь.',
        )
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, docs.map((doc) => h(DocRow, { key: doc.path, doc })))
    }

    function ProjectsTab({ projects, loading }) {
      if (loading && !projects) return h('div', { style: { fontSize: 12, opacity: 0.65, padding: '12px 0' } }, 'Собираю проекты…')
      if (!projects?.length) {
        return h(
          'div',
          { style: { fontSize: 12, opacity: 0.65, padding: '12px 0' } },
          'Проекты не найдены. Открой проект в отдельной сессии — он появится в этом списке.',
        )
      }
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        projects.map((row) =>
          h(
            'div',
            { key: row.path ?? row.name, style: { fontSize: 12, lineHeight: '17px' } },
            h(
              'div',
              { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
              h('span', { style: { fontWeight: 600 } }, row.name),
              h('span', { style: chip() }, practiceLabel(row.practice)),
              h('span', { style: { opacity: 0.75 } }, row.phaseLabel),
              row.warnings > 0 ? h('span', { style: { color: C.warn } }, `⚠${row.warnings}`) : null,
            ),
            row.change ? h('div', { style: { fontSize: 10, opacity: 0.55, fontFamily: mono, wordBreak: 'break-all' } }, row.change) : null,
          ),
        ),
      )
    }

    // ------------------------------------------------------------------
    // Panel shell
    // ------------------------------------------------------------------
    function Panel() {
      const snapshot = useStore()

      React.useEffect(() => {
        if (snapshot.open && currentSessionId) void load(currentSessionId, true)
      }, [snapshot.open, currentSessionId])

      React.useEffect(() => {
        if (snapshot.open && snapshot.tab === 'projects' && !snapshot.projects && !snapshot.projectsLoading) void loadProjects()
      }, [snapshot.open, snapshot.tab, snapshot.projects, snapshot.projectsLoading])

      if (!snapshot.open) return null
      const close = () => setState({ open: false })
      const data = snapshot.data
      const tabs = [
        ['status', 'Статус'],
        ['tasks', 'Задачи'],
        ['stats', 'Метрики'],
        ['docs', 'Документы'],
        ['projects', 'Проекты'],
      ]
      const reload = () => (snapshot.tab === 'projects' ? loadProjects() : load(currentSessionId, true))
      const busy = snapshot.refreshing || snapshot.projectsLoading

      const body = h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            width: '100%',
            maxWidth: 720,
            minWidth: 300,
            boxSizing: 'border-box',
          },
        },
        // Tabs wrap instead of clipping; the refresh action lives in the footer.
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
        !data
          ? h(
              'div',
              { style: { fontSize: 12, opacity: 0.65, padding: '14px 0' } },
              snapshot.status === 'error' ? `Не удалось получить состояние: ${snapshot.error}` : 'Состояние ещё не вычислено — открой проект и напиши сообщение.',
            )
          : snapshot.tab === 'status'
            ? h(StatusTab, { data })
            : snapshot.tab === 'tasks'
              ? h(TasksTab, { data, moving: snapshot.moving, moveError: snapshot.moveError })
              : snapshot.tab === 'stats'
                ? h(StatsTab, { data })
                : snapshot.tab === 'projects'
                  ? h(ProjectsTab, { projects: snapshot.projects, loading: snapshot.projectsLoading })
                  : h(DocsTab, { data }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 6, paddingTop: 8, borderTop: '1px solid rgba(127,127,127,0.18)', flexWrap: 'wrap', alignItems: 'center' } },
          h('button', { type: 'button', onClick: () => void reload(), disabled: busy, style: button() }, busy ? 'Обновляю…' : 'Обновить'),
          h('button', { type: 'button', onClick: close, style: button() }, 'Закрыть'),
          h('span', { style: { flex: 1 } }),
          data?.project?.root
            ? h('span', { title: data.project.root, style: { fontSize: 9, opacity: 0.4, fontFamily: mono, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, truncateMiddle(data.project.root, 34))
            : null,
        ),
      )

      const Modal = primitives?.Modal
      if (typeof Modal === 'function') {
        return h(Modal, { open: true, onClose: close, title: 'SDD-компас', closeLabel: 'Закрыть' }, body)
      }
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
              width: 'min(720px, 96vw)',
              maxHeight: '84vh',
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
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register({ name: 'conversation.composer.dock', id: 'sdd-compass', order: 6 }, SddDock),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'sdd-compass.panel' }, Panel),
        )
      },
    }
  },
})
