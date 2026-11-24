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
    const OK = '#22c55e'
    const WARN = '#f59e0b'
    const BAD = '#ef4444'
    const MUTED = '#94a3b8'

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
    // Formatting helpers
    // ------------------------------------------------------------------
    const chipStyle = (extra) => ({
      display: 'inline-flex',
      alignItems: 'baseline',
      gap: 6,
      fontSize: 11,
      lineHeight: '16px',
      whiteSpace: 'nowrap',
      fontVariantNumeric: 'tabular-nums',
      ...extra,
    })

    const buttonStyle = { padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12 }

    function dotColor(data) {
      if (!data) return MUTED
      if (data.findings?.some((finding) => finding.severity === 'error')) return BAD
      if (data.findings?.some((finding) => finding.severity === 'warn')) return WARN
      if (data.phase === 'archive') return OK
      if (data.phase === 'idle' || data.phase === 'unknown') return MUTED
      return WARN
    }

    function daysText(days) {
      if (days === null || days === undefined) return '—'
      return `${days} дн`
    }

    function warnCount(data) {
      return (data?.findings ?? []).filter((finding) => finding.severity === 'warn' || finding.severity === 'error').length
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
            style: chipStyle({ color: BAD, cursor: 'pointer' }),
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
          title: `${data.project?.name ?? ''} · ${data.practice} · ${data.phaseLabel}\n${data.next?.label ?? ''}\nклик — подробности`,
          onClick: () => setState({ open: true, tab: 'status' }),
          style: chipStyle({ gap: 8, cursor: 'pointer', justifyContent: 'center', padding: '2px 0' }),
        },
        h('span', { style: { opacity: 0.6, fontWeight: 600 } }, 'SDD'),
        h('span', { style: { color: dotColor(data) } }, '●'),
        h('span', null, data.phaseLabel),
        tasks && tasks.total > 0 ? h('span', { style: { opacity: 0.7 } }, `${tasks.done}/${tasks.total}`) : null,
        warn > 0 ? h('span', { style: { color: WARN } }, `⚠ ${warn}`) : null,
      )
    }

    // ------------------------------------------------------------------
    // Panel
    // ------------------------------------------------------------------
    function PhaseDots({ phase }) {
      const index = PHASES.indexOf(phase)
      return h(
        'div',
        { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', margin: '6px 0' } },
        PHASES.map((item, position) =>
          h(
            'span',
            {
              key: item,
              title: PHASE_LABELS[item] ?? item,
              style: {
                width: position === index ? 22 : 8,
                height: 8,
                borderRadius: 4,
                background: position < index ? OK : position === index ? WARN : 'rgba(127,127,127,0.35)',
                transition: 'width 120ms ease',
              },
            },
          ),
        ),
      )
    }

    function Row({ label, value, color }) {
      return h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: '130px 1fr', gap: 8, padding: '2px 0', fontSize: 12 } },
        h('span', { style: { opacity: 0.6 } }, label),
        h('span', { style: { color } }, value),
      )
    }

    function Findings({ findings }) {
      if (!findings || findings.length === 0) return h('div', { style: { opacity: 0.7, fontSize: 12 } }, 'Замечаний нет.')
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        findings.map((finding, index) =>
          h(
            'div',
            {
              key: `${finding.rule}-${index}`,
              style: {
                fontSize: 12,
                lineHeight: '17px',
                color: finding.severity === 'warn' ? WARN : finding.severity === 'error' ? BAD : 'inherit',
              },
            },
            `${finding.severity === 'warn' ? '⚠' : finding.severity === 'error' ? '✕' : '·'} ${finding.message}`,
          ),
        ),
      )
    }

    function StatusTab({ data }) {
      const change = data.change
      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, data.phaseLabel),
          h('span', { style: { opacity: 0.6, fontSize: 11 } }, `${data.practice} · ${data.project?.branch ?? '—'}`),
        ),
        h(PhaseDots, { phase: data.phase }),
        change
          ? h(
              'div',
              null,
              h(Row, { label: 'Изменение', value: change.id }),
              change.title ? h(Row, { label: 'Название', value: change.title }) : null,
              h(Row, { label: 'Обновлено', value: daysText(change.updatedDays) }),
              change.tasks ? h(Row, { label: 'Задачи', value: `${change.tasks.done}/${change.tasks.total}` }) : null,
              change.questions?.total ? h(Row, { label: 'Вопросы', value: String(change.questions.total) }) : null,
            )
          : h('div', { style: { fontSize: 12, opacity: 0.7, margin: '6px 0' } }, 'Активных изменений нет.'),
        data.next
          ? h(
              'div',
              { style: { marginTop: 10, padding: '8px 10px', borderRadius: 8, background: 'rgba(127,127,127,0.12)' } },
              h('div', { style: { fontSize: 11, opacity: 0.6 } }, 'Следующий шаг'),
              h('div', { style: { fontSize: 12, fontWeight: 600 } }, data.next.label),
              data.next.hint ? h('div', { style: { fontSize: 11, opacity: 0.7, marginTop: 2 } }, data.next.hint) : null,
            )
          : null,
        data.rule ? h('div', { style: { fontSize: 11, opacity: 0.7, marginTop: 8 } }, data.rule) : null,
        h('div', { style: { marginTop: 12, fontSize: 11, opacity: 0.6 } }, 'Замечания'),
        h(Findings, { findings: data.findings }),
        h('div', { style: { marginTop: 12, fontSize: 11, opacity: 0.6 } }, 'Документы'),
        data.docs?.length
          ? data.docs.map((doc) => h('div', { key: doc.path, style: { fontSize: 11, lineHeight: '16px', wordBreak: 'break-all' } }, `${doc.path} — ${doc.why}`))
          : h('div', { style: { fontSize: 11, opacity: 0.7 } }, 'Не найдены.'),
      )
    }

    function StatsTab({ data }) {
      const snapshot = data.stats?.snapshot
      const history = data.stats?.history
      if (!snapshot) return h('div', { style: { fontSize: 12, opacity: 0.7 } }, 'Статистика недоступна.')
      return h(
        'div',
        null,
        h(Row, { label: 'Фаза', value: `${data.phaseLabel}${snapshot.daysInPhase !== null ? ` · ${snapshot.daysInPhase} дн` : ''}` }),
        h(Row, { label: 'В работе', value: String(snapshot.wip) }),
        h(Row, { label: 'Задачи', value: `${snapshot.tasks.done}/${snapshot.tasks.total}` }),
        snapshot.stuck?.length
          ? h(
              'div',
              { style: { marginTop: 8 } },
              h('div', { style: { fontSize: 11, opacity: 0.6 } }, 'Застряло'),
              snapshot.stuck.map((item) =>
                h('div', { key: item.id, style: { fontSize: 11, color: WARN } }, `${item.id} — ${item.days} дн (${PHASE_LABELS[item.phase] ?? item.phase})`),
              ),
            )
          : null,
        h('div', { style: { marginTop: 12, fontSize: 11, opacity: 0.6 } }, 'История (git)'),
        history?.available
          ? h(
              'div',
              null,
              history.cycleMedianDays !== null
                ? h(Row, { label: 'Цикл', value: `${history.cycleMedianDays} дн медиана · p90 ${history.cycleP90Days} · n=${history.sample}` })
                : h(Row, { label: 'Цикл', value: 'мало данных' }),
              history.archiveRate !== null ? h(Row, { label: 'До архива', value: `${Math.round(history.archiveRate * 100)}%` }) : null,
              history.drift7d !== null ? h(Row, { label: 'Дрейф 7 дн', value: `${history.drift7d} файл(ов) кода` }) : null,
            )
          : h('div', { style: { fontSize: 11, opacity: 0.7 } }, history?.reason ?? 'История недоступна.'),
        data.trace
          ? h(Row, {
              label: '@sdd',
              value: `${data.trace.files} файл(ов)${data.trace.requirementIds ? ` · требования ${data.trace.covered}/${data.trace.requirementIds}` : ''} · связь с change ${data.trace.linkedChange}`,
            })
          : null,
      )
    }

    function ProjectsTab({ projects, loading }) {
      if (loading && !projects) return h('div', { style: { fontSize: 12, opacity: 0.7, padding: '12px 0' } }, 'Собираю проекты…')
      if (!projects?.length) return h('div', { style: { fontSize: 12, opacity: 0.7, padding: '12px 0' } }, 'Проекты не найдены: нет workspace-реестра.')
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        projects.map((row) =>
          h(
            'div',
            { key: row.path ?? row.name, style: { fontSize: 12, display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontWeight: 600 } }, row.name),
            h('span', { style: { opacity: 0.65 } }, row.practice),
            h('span', null, row.phaseLabel),
            row.change ? h('span', { style: { opacity: 0.75, wordBreak: 'break-all' } }, `"${row.change}"`) : null,
            row.warnings > 0 ? h('span', { style: { color: WARN } }, `⚠${row.warnings}`) : null,
          ),
        ),
      )
    }

    function DocsTab({ data }) {
      if (!data.docs?.length) return h('div', { style: { fontSize: 12, opacity: 0.7 } }, 'Документы не найдены.')
      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        data.docs.map((doc) =>
          h(
            'div',
            { key: doc.path },
            h('div', { style: { fontSize: 12, wordBreak: 'break-all' } }, doc.path),
            h('div', { style: { fontSize: 11, opacity: 0.6 } }, doc.why),
          ),
        ),
      )
    }

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
        ['stats', 'Статистика'],
        ['docs', 'Документы'],
        ['projects', 'Проекты'],
      ]

      const body = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 4, width: '100%', maxWidth: 460, boxSizing: 'border-box' } },
        h(
          'div',
          { style: { display: 'flex', gap: 6, borderBottom: '1px solid rgba(127,127,127,0.25)', paddingBottom: 6 } },
          tabs.map(([id, label]) =>
            h(
              'button',
              {
                key: id,
                type: 'button',
                onClick: () => setState({ tab: id }),
                style: {
                  ...buttonStyle,
                  border: 'none',
                  background: snapshot.tab === id ? 'rgba(127,127,127,0.18)' : 'transparent',
                  color: 'inherit',
                  fontWeight: snapshot.tab === id ? 600 : 400,
                },
              },
              label,
            ),
          ),
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              type: 'button',
              onClick: () => (snapshot.tab === 'projects' ? void loadProjects() : void load(currentSessionId, true)),
              disabled: snapshot.refreshing || snapshot.projectsLoading,
              style: buttonStyle,
            },
            snapshot.refreshing || snapshot.projectsLoading ? '…' : 'Обновить',
          ),
        ),
        !data
          ? h('div', { style: { fontSize: 12, opacity: 0.7, padding: '12px 0' } }, snapshot.status === 'error' ? `Ошибка: ${snapshot.error}` : 'Состояние ещё не вычислено.')
          : snapshot.tab === 'status'
            ? h(StatusTab, { data })
            : snapshot.tab === 'stats'
              ? h(StatsTab, { data })
              : snapshot.tab === 'projects'
                ? h(ProjectsTab, { projects: snapshot.projects, loading: snapshot.projectsLoading })
                : h(DocsTab, { data }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } },
          h('button', { type: 'button', onClick: close, style: buttonStyle }, 'Закрыть'),
          data ? h('span', { style: { fontSize: 10, opacity: 0.5, alignSelf: 'center', wordBreak: 'break-all' } }, data.project?.root ?? '') : null,
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
          },
        },
        h(
          'div',
          {
            onClick: (event) => event.stopPropagation(),
            style: {
              background: 'Canvas',
              color: 'CanvasText',
              border: '1px solid rgba(127,127,127,0.4)',
              borderRadius: 10,
              padding: 16,
              width: 'min(460px, 92vw)',
              maxHeight: '80vh',
              overflow: 'auto',
              boxSizing: 'border-box',
            },
          },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, 'SDD-компас'),
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
