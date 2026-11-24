/**
 * Findings: the concrete reasons the compass shows a warning. Every rule is
 * advisory and evidence-backed; nothing here blocks a tool call.
 */

/** Highest severity present in a findings list. */
export function worstSeverity(findings) {
  if (!Array.isArray(findings)) return 'info'
  if (findings.some((finding) => finding?.severity === 'error')) return 'error'
  if (findings.some((finding) => finding?.severity === 'warn')) return 'warn'
  return 'info'
}

/**
 * Decide whether a CI run fails for a findings list.
 * @param {Array<{severity: string}>} findings
 * @param {'error'|'warn'|'none'} failOn
 */
export function shouldFail(findings, failOn = 'warn') {
  const worst = worstSeverity(findings)
  if (failOn === 'none') return false
  if (failOn === 'error') return worst === 'error'
  return worst === 'warn' || worst === 'error'
}

/**
 * Run the configured checks.
 * @param {{ project: any, practice: string, change: any, changes: any[], config: any, now: number, driftPaths: string[]|null, archivedCount: number, candidates: string[] }} input
 * @returns {Array<{ rule: string, severity: 'error'|'warn'|'info', message: string, paths?: string[] }>}
 */
export function runChecks(input) {
  const { project, practice, change, changes, config, now, driftPaths, archivedCount, candidates, trace, links } = input
  const checks = { drift: true, archive: true, stale: true, statuses: true, trace: true, ...(config?.checks ?? {}) }
  const staleAfterDays = Number.isFinite(config?.staleAfterDays) ? config.staleAfterDays : 14
  const findings = []
  const day = 86_400_000
  const updatedDays = change?.updatedAt ? (now - change.updatedAt) / day : null

  if (practice === 'unknown') {
    findings.push({
      rule: 'practice.unsupported',
      severity: 'info',
      message: 'Признаки SDD в проекте не найдены',
    })
    return findings
  }

  if (candidates && candidates.length > 1) {
    findings.push({
      rule: 'practice.ambiguous',
      severity: 'info',
      message: `Найдено несколько практик SDD (${candidates.join(', ')}); выбрана ${practice}. Уточните practice в .sdd/config.json`,
    })
  }

  if (change && !change.archived) {
    if (checks.archive && change.phase === 'verify' && updatedDays !== null && updatedDays > 7) {
      findings.push({
        rule: 'archive.pending',
        severity: 'warn',
        message: `Задачи выполнены, но изменение не заархивировано ${Math.floor(updatedDays)} дн.`,
      })
    } else if (checks.stale && updatedDays !== null && updatedDays > staleAfterDays) {
      findings.push({
        rule: 'change.stale',
        severity: 'warn',
        message: `Изменение не обновлялось ${Math.floor(updatedDays)} дн. (порог ${staleAfterDays}).`,
      })
    }

    if (checks.statuses && practice === 'scratch' && change.tasks && change.tasks.done === 0 && change.tasks.active === 0 && updatedDays !== null && updatedDays > 14) {
      findings.push({
        rule: 'status.stale',
        severity: 'info',
        message: 'Статусы задач не двигались: ни одна не начата и не закрыта.',
      })
    }
  }

  if (checks.drift && change && ['proposal', 'spec', 'design'].includes(change.phase) && project.codeChanges.length > 0) {
    findings.push({
      rule: 'drift.code-without-change',
      severity: 'warn',
      message: `Правки кода без утверждённой спеки: ${project.codeChanges.length} файл(ов) в рабочем дереве.`,
      paths: project.codeChanges.slice(0, 5),
    })
  }

  if (checks.drift && change && ['proposal', 'spec'].includes(change.phase) && Array.isArray(driftPaths) && driftPaths.length > 0) {
    findings.push({
      rule: 'drift.recent',
      severity: 'warn',
      message: `За 7 дней изменено ${driftPaths.length} файл(ов) кода вне SDD-артефактов при фазе ${change.phase}.`,
      paths: driftPaths.slice(0, 5),
    })
  }

  if (change && change.phase === 'tasks' && change.tasks && change.tasks.total === 0) {
    findings.push({
      rule: 'tasks.empty',
      severity: 'info',
      message: 'Артефакты готовы, но задачи не нарезаны.',
    })
  }

  // Scratch: tickets that were never started, and done tickets with open boxes.
  if (checks.statuses && practice === 'scratch' && change?.issues?.length) {
    const untouched = change.issues.filter(
      (issue) => !['done', 'completed', 'closed', 'wontfix', 'wont-fix'].includes(issue.status) && issue.status !== 'unknown',
    )
    const started = change.issues.some((issue) => ['in-progress', 'in_progress', 'review', 'in-review', 'blocked'].includes(issue.status))
    if (!started && untouched.length > 0 && updatedDays !== null && updatedDays > staleAfterDays) {
      findings.push({
        rule: 'status.ready-stuck',
        severity: 'info',
        message: `${untouched.length} тикет(ов) не начаты, изменение не обновлялось ${Math.floor(updatedDays)} дн.`,
      })
    }
    const doneWithoutBoxes = change.issues.filter(
      (issue) =>
        ['done', 'completed', 'closed'].includes(issue.status) &&
        issue.checkboxes &&
        issue.checkboxes.total > 0 &&
        issue.checkboxes.done === 0,
    )
    if (doneWithoutBoxes.length > 0) {
      findings.push({
        rule: 'ticket.checkboxes',
        severity: 'warn',
        message: `Тикеты закрыты без отмеченных пунктов: ${doneWithoutBoxes.map((issue) => issue.id).join(', ')}.`,
        paths: doneWithoutBoxes.map((issue) => issue.path),
      })
    }
  }

  // SSC: unresolved artifact reviews and blocking open questions.
  if (practice === 'ssc' && change) {
    if (change.parseError) {
      findings.push({ rule: 'ssc.parse', severity: 'warn', message: change.parseError })
    }
    if (change.review?.pending > 0) {
      findings.push({
        rule: 'ssc.review',
        severity: 'warn',
        message: `Артефакты ждут согласования: ${change.review.pending} из ${change.review.total}.`,
      })
    }
    if (change.questions?.blockers > 0) {
      findings.push({
        rule: 'ssc.blockers',
        severity: 'warn',
        message: `Открытых блокирующих вопросов: ${change.questions.blockers} из ${change.questions.total}.`,
      })
    }
  }

  if (practice === 'openspec' && checks.archive && archivedCount === 0) {
    const complete = changes.filter(
      (item) => !item.archived && item.has.tasks && item.tasks.total > 0 && item.tasks.done === item.tasks.total,
    )
    if (complete.length > 0) {
      findings.push({
        rule: 'archive.never',
        severity: 'info',
        message: `Готовых изменений: ${complete.length}, но в openspec/changes/archive/ ещё ничего не заархивировано.`,
      })
    }
  }

  // Traceability: @sdd annotations must reference known ids, and a change in
  // apply/verify should leave a trace in the code it touched.
  if (checks.trace && trace) {
    if (trace.unknown.length > 0) {
      findings.push({
        rule: 'trace.unknown',
        severity: 'warn',
        message: `Аннотации @sdd ссылаются на неизвестные ID: ${trace.unknown.join(', ')}.`,
      })
    }
    if (practice === 'ssc' && trace.requirementIds > 0 && trace.files > 0 && trace.covered < trace.requirementIds) {
      findings.push({
        rule: 'trace.orphan',
        severity: 'info',
        message: `Требования без аннотаций @sdd: ${trace.requirementIds - trace.covered} из ${trace.requirementIds}.`,
      })
    }
    if (
      change &&
      ['apply', 'verify'].includes(change.phase) &&
      project.codeChanges.length > 0 &&
      trace.linkedChange === 0 &&
      (practice !== 'ssc' || trace.covered === 0)
    ) {
      findings.push({
        rule: 'trace.unannotated',
        severity: 'info',
        message: 'Изменённый код не содержит аннотаций @sdd — связь с изменением не прослеживается.',
      })
    }
  }

  // Impact map: declared files versus what actually changed.
  if (checks.drift && change && links) {
    if (links.impact > 0 && links.changed > 0 && links.changedInImpact === 0) {
      findings.push({
        rule: 'link.impact-missed',
        severity: 'info',
        message: `Impact перечисляет ${links.impact} путь(ей), но ни один изменённый файл под них не попадает.`,
      })
    }
    if (links.untrackedCount > 0 && ['apply', 'verify'].includes(change.phase)) {
      findings.push({
        rule: 'link.untracked',
        severity: 'warn',
        message: `Изменено вне Impact и без @sdd: ${links.untrackedCount} файл(ов).`,
        paths: links.untracked,
      })
    }
  }

  return findings
}
