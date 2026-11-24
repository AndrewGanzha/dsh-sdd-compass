/**
 * Rendering: the same state projected into the system-prompt section, the
 * session-start injection, `/sdd` replies and tool output. Everything here is
 * pure and bounded — the prompt section must stay short and byte-stable for a
 * given state.
 */

const PROMPT_LIMIT = 640
const SESSION_LIMIT = 900

/** Trim a list to `max` items with an ellipsis marker. */
function list(items, max) {
  const values = items.filter(Boolean)
  if (values.length <= max) return values.join(', ')
  return `${values.slice(0, max).join(', ')} и ещё ${values.length - max}`
}

/** Shorten a string to a limit, keeping a word boundary when possible. */
function clamp(text, limit) {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit - 1)
  const space = cut.lastIndexOf(' ')
  return `${space > limit * 0.6 ? cut.slice(0, space) : cut}…`
}

/** One-line change summary: `change "id" · задачи 2/5 · вопросов 1`. */
function changeLine(change) {
  if (!change) return 'изменение не выбрано'
  const tasks = change.tasks && change.tasks.total > 0 ? ` · задачи ${change.tasks.done}/${change.tasks.total}` : ''
  const questions = change.questions && change.questions.total > 0 ? ` · вопросов ${change.questions.total}` : ''
  return `change "${change.id}"${tasks}${questions}`
}

/**
 * System-prompt section text. Empty string keeps the section inert.
 * @param {any} state
 * @returns {string}
 */
export function promptText(state) {
  if (!state || !state.practiceSupported || state.practice === 'unknown') return ''
  if (state.phase === 'idle') {
    return clamp(`SDD · ${state.practice} · активных изменений нет. Новое изменение начинается со спеки (/sdd init).`, PROMPT_LIMIT)
  }
  const lines = [`SDD · ${state.practice} · фаза ${state.phaseLabel} · ${changeLine(state.change)}`]
  if (state.next) lines.push(`Следующий шаг: ${state.next.label}${state.next.hint ? ` — ${state.next.hint}` : ''}`)
  if (state.rule) lines.push(state.rule)
  if (state.docs && state.docs.length > 0) lines.push(`Документы: ${list(state.docs.map((doc) => doc.path), 3)}.`)
  if (state.findings && state.findings.length > 0) {
    const top = state.findings.find((finding) => finding.severity === 'warn') ?? state.findings[0]
    lines.push(`Замечание: ${top.message}`)
  }
  return clamp(lines.join('\n'), PROMPT_LIMIT)
}

/**
 * Session-start injection text — one model-facing message per session.
 * @param {any} state
 * @returns {string}
 */
export function sessionText(state) {
  if (!state || !state.practiceSupported || state.phase === 'idle' || !state.change) return ''
  const lines = [
    `SDD-компас: проект ${state.project.name}, практика ${state.practice}, изменение "${state.change.id}", фаза ${state.phaseLabel}.`,
  ]
  if (state.docs && state.docs.length > 0) {
    lines.push(`Прежде чем менять код, прочитай: ${list(state.docs.map((doc) => doc.path), 3)}.`)
  }
  if (state.rule) lines.push(state.rule)
  if (state.next) lines.push(`Следующий шаг: ${state.next.label}${state.next.hint ? ` (${state.next.hint})` : ''}.`)
  if (state.findings && state.findings.length > 0) {
    const warnings = state.findings.filter((finding) => finding.severity === 'warn')
    if (warnings.length > 0) lines.push(`Замечания: ${list(warnings.map((finding) => finding.message), 2)}.`)
  }
  return clamp(lines.join('\n'), SESSION_LIMIT)
}

/** `/sdd` status reply. */
export function statusText(state) {
  if (!state) return 'Состояние SDD ещё не вычислено. Подожди или вызови /sdd refresh.'
  const lines = []
  lines.push(`SDD · ${state.project.name}${state.project.branch ? ` · ${state.project.branch}` : ''} · ${state.practice}`)
  if (!state.practiceSupported) {
    lines.push(state.note ?? 'Практика SDD не распознана.')
    return lines.join('\n')
  }
  if (state.phase === 'idle') {
    lines.push('Активных изменений нет.')
  } else {
    lines.push(`Фаза: ${state.phaseLabel}${state.change?.updatedDays !== null ? ` · обновлено ${state.change.updatedDays} дн назад` : ''}`)
    lines.push(`Изменение: "${state.change?.id}" — ${state.change?.title ?? ''}`)
    if (state.change?.tasks && state.change.tasks.total > 0) {
      lines.push(`Задачи: ${state.change.tasks.done}/${state.change.tasks.total}`)
    }
    if (state.change?.questions?.total) {
      const blockers = state.change.questions.blockers > 0 ? ` (блокирующих ${state.change.questions.blockers})` : ''
      lines.push(`Открытые вопросы: ${state.change.questions.total}${blockers}`)
    }
    if (state.change?.review?.total) {
      lines.push(`Согласование артефактов: ${state.change.review.agreed}/${state.change.review.total}`)
    }
    if (state.change?.version) lines.push(`Версия модели: ${state.change.version}`)
    if (state.change?.workflow?.next) lines.push(`Workflow: ${state.change.workflow.next}`)
    if (state.next) lines.push(`Дальше: ${state.next.label}${state.next.hint ? ` (${state.next.hint})` : ''}`)
  }
  if (state.findings && state.findings.length > 0) {
    lines.push('', 'Замечания:')
    for (const finding of state.findings.slice(0, 6)) lines.push(`- ${finding.severity}: ${finding.message}`)
  }
  if (state.docs && state.docs.length > 0) {
    lines.push('', 'Документы:')
    for (const doc of state.docs) lines.push(`- ${doc.path} — ${doc.why}`)
  }
  if (state.configError) lines.push('', state.configError)
  lines.push('', 'Команды: /sdd next · /sdd check · /sdd docs · /sdd stats · /sdd init · /sdd refresh')
  return lines.join('\n')
}

/** `/sdd next` reply: one action plus the command that performs it. */
export function nextText(state) {
  if (!state || state.phase === 'idle') return 'Активных SDD-изменений нет. /sdd init — начать.'
  const lines = [`Фаза: ${state.phaseLabel} · изменение "${state.change?.id}"`]
  if (state.next) lines.push(`Шаг: ${state.next.label}${state.next.hint ? ` — ${state.next.hint}` : ''}`)
  if (state.change?.tasks && state.change.tasks.total > 0) {
    lines.push(`Прогресс задач: ${state.change.tasks.done}/${state.change.tasks.total}`)
  }
  if (state.rule) lines.push(`Правило: ${state.rule}`)
  return lines.join('\n')
}

/** `/sdd check` reply. */
export function findingsText(state) {
  if (!state) return 'Состояние ещё не вычислено.'
  if (!state.findings || state.findings.length === 0) return 'Замечаний нет.'
  return ['Замечания:', ...state.findings.map((finding) => `- ${finding.severity}: ${finding.message}`)].join('\n')
}

/** `/sdd docs` reply. */
export function docsText(state) {
  if (!state || !state.docs || state.docs.length === 0) return 'Документы не найдены.'
  return ['Документы:', ...state.docs.map((doc) => `- ${doc.path} — ${doc.why}`)].join('\n')
}

/** `/sdd stats` reply: the snapshot plus git history. */
export function statsText(state) {
  if (!state) return 'Состояние ещё не вычислено.'
  const snapshot = state.stats?.snapshot
  const history = state.stats?.history
  const lines = ['Статистика SDD:']
  if (snapshot) {
    lines.push(`- фаза: ${state.phaseLabel}${snapshot.daysInPhase !== null ? ` (${snapshot.daysInPhase} дн)` : ''}`)
    lines.push(`- в работе: ${snapshot.wip} изменени(й)`)
    lines.push(`- задачи: ${snapshot.tasks.done}/${snapshot.tasks.total}`)
    if (snapshot.stuck.length > 0) {
      lines.push(`- застряло: ${snapshot.stuck.map((item) => `${item.id} (${item.days} дн)`).join(', ')}`)
    }
  }
  if (history?.available) {
    if (history.cycleMedianDays !== null) {
      lines.push(`- цикл: ${history.cycleMedianDays} дн медиана, p90 ${history.cycleP90Days} (n=${history.sample})`)
    }
    if (history.archiveRate !== null) lines.push(`- дошли до архива: ${Math.round(history.archiveRate * 100)}%`)
    if (history.drift7d !== null) lines.push(`- дрейф за 7 дней: ${history.drift7d} файл(ов) кода вне артефактов`)
  } else if (history?.reason) {
    lines.push(`- история недоступна: ${history.reason}`)
  }
  if (state.trace) {
    const trace = state.trace
    const coverage = trace.requirementIds > 0 ? ` · требования ${trace.covered}/${trace.requirementIds}` : ''
    lines.push(`- аннотации @sdd: ${trace.files} файл(ов)${coverage} · связь с change: ${trace.linkedChange} файл(ов)`)
  }
  return lines.join('\n')
}

/**
 * `/sdd advance` reply: the exact command for the next step, never executed.
 * @param {any} state
 */
export function advanceText(state) {
  if (!state) return 'Состояние ещё не вычислено.'
  if (state.phase === 'idle') return 'Активных SDD-изменений нет. /sdd init — начать.'
  const changeId = state.change?.id ?? '<change>'
  const lines = [`Фаза: ${state.phaseLabel} · изменение "${changeId}"`]
  if (state.next) lines.push(`Шаг: ${state.next.label}`)
  let command = null
  if (state.practice === 'openspec') {
    if (state.phase === 'verify' || state.phase === 'archive') {
      command = `openspec archive --change ${changeId}`
    } else if (['proposal', 'spec', 'design', 'tasks'].includes(state.phase)) {
      command = `openspec instructions ${state.phase} --change ${changeId}`
    }
  } else if (state.practice === 'scratch') {
    command = state.phase === 'tasks' ? 'разбей спеку на issues/NN-*.md' : '/sdd next'
  } else if (state.practice === 'ssc') {
    command = state.change?.workflow?.next ?? 'закрой блокирующие вопросы в model.json'
  }
  if (command) lines.push(`Команда: ${command}`)
  lines.push('Плагин ничего не выполняет сам: запусти команду вручную и подтверди.')
  return lines.join('\n')
}

/**
 * `/sdd projects` reply: portfolio across workspace projects.
 * @param {Array<any>} rows
 */
export function portfolioText(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 'Проекты не найдены: нет workspace-реестра или плагин ещё не видел сессий.'
  const lines = [`Проекты (${rows.length}):`]
  for (const row of rows) {
    const warnings = row.warnings > 0 ? ` · ⚠${row.warnings}` : ''
    const change = row.change ? ` · "${row.change}"` : ''
    lines.push(`- ${row.name} · ${row.practice} · ${row.phaseLabel}${change}${warnings}`)
  }
  return lines.join('\n')
}

/**
 * Model-facing warning appended after a code write in a pre-implementation
 * phase. Empty when the phase does not need the nudge.
 * @param {any} state
 * @param {string} path - written file.
 * @returns {string}
 */
export function writeWarningText(state, path) {
  if (!state || !path || !['proposal', 'spec', 'design'].includes(state.phase)) return ''
  if (state.strictness === 'quiet' || state.strictness === 'info') return ''
  const next = state.next ? `Сначала ${state.next.label}${state.next.hint ? ` (${state.next.hint})` : ''}.` : 'Сначала спека.'
  return `SDD-предупреждение: записан ${path} в фазе «${state.phaseLabel}» для изменения "${state.change?.id ?? '—'}". Код до утверждённой спеки — это дрейф. ${next}`
}

/**
 * Denial reason for the optional hard gate.
 * @param {any} state
 * @param {string} path - attempted write.
 * @returns {string}
 */
export function gateReasonText(state, path) {
  if (!state || state.strictness !== 'gate') return ''
  const next = state.next ? `/sdd next` : ''
  return `SDD-гейт: запись в ${path} заблокирована — фаза «${state.phaseLabel}», изменение "${state.change?.id ?? '—'}". Утверди спеку (${next}) или переключи strictness на "warn" в .sdd/config.json.`
}
