/**
 * Model-facing tools. Raw ToolDefinition objects (no SDK imports), so the
 * plugin stays dependency-free and loads on any build that registers tools by
 * definition.
 */

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true }

function textBlock(text) {
  return [{ type: 'text', text }]
}

function findingsSummary(value) {
  const findings = Array.isArray(value?.findings) ? value.findings : []
  if (findings.length === 0) return 'замечаний нет'
  const warns = findings.filter((finding) => finding.severity === 'warn').length
  return `${findings.length} (warn: ${warns})`
}

function statusTextFor(value) {
  if (!value || value.ok === false) return `SDD: состояние недоступно (${value?.error ?? 'нет данных'}).`
  const lines = [
    `SDD · ${value.project?.name ?? '?'} · ${value.practice} · фаза ${value.phaseLabel} · ${value.change ? `change "${value.change.id}"` : 'изменения нет'}`,
  ]
  if (value.change?.tasks) lines.push(`Задачи: ${value.change.tasks.done}/${value.change.tasks.total}`)
  if (value.change?.questions?.total) lines.push(`Открытые вопросы: ${value.change.questions.total}`)
  if (value.next) lines.push(`Следующий шаг: ${value.next.label}${value.next.hint ? ` — ${value.next.hint}` : ''}`)
  lines.push(`Замечания: ${findingsSummary(value)}`)
  if (value.docs?.length) lines.push(`Документы: ${value.docs.map((doc) => doc.path).join(', ')}`)
  return lines.join('\n')
}

function checkTextFor(value) {
  if (!value || value.ok === false) return `SDD: проверка недоступна (${value?.error ?? 'нет данных'}).`
  if (!Array.isArray(value.findings) || value.findings.length === 0) return 'Замечаний нет.'
  return ['Замечания:', ...value.findings.map((finding) => `- ${finding.severity}: ${finding.message}`)].join('\n')
}

/**
 * `sdd_projects` — portfolio across workspace projects.
 * @param {{ projects: () => Promise<any> }} service
 */
export function projectsTool(service) {
  return {
    name: 'sdd_projects',
    description:
      'List the SDD state of every workspace project the host knows: project name, practice, phase, active change and warning count. Use it when the user asks about progress across projects.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return textBlock(projectsTextFor(value))
      },
    },
    isConcurrencySafe: () => true,
    async execute() {
      return service.projects()
    },
  }
}

function projectsTextFor(value) {
  if (!value?.projects?.length) return 'Проекты не найдены.'
  return [
    'Проекты:',
    ...value.projects.map(
      (row) => `- ${row.name} · ${row.practice} · ${row.phaseLabel}${row.change ? ` · "${row.change}"` : ''}${row.warnings ? ` · ⚠${row.warnings}` : ''}`,
    ),
  ].join('\n')
}

/**
 * `sdd_tasks` — kanban task list of the active change.
 * @param {{ tasks: (exec: any) => Promise<any> }} service
 */
export function tasksTool(service) {
  return {
    name: 'sdd_tasks',
    description:
      'List the tasks of the active SDD change as kanban columns (todo, doing, review, done): scratch tickets or OpenSpec checkboxes, with paths and line numbers. Use it to pick the next task or to report board state.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return textBlock(tasksTextFor(value))
      },
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return service.tasks(exec)
    },
  }
}

/**
 * `sdd_task_move` — move one task between kanban columns.
 * @param {{ moveTask: (exec: any, request: any) => Promise<any> }} service
 */
export function taskMoveTool(service) {
  return {
    name: 'sdd_task_move',
    description:
      'Move one task of the active change to another kanban column by rewriting its status: the `**Status:**` line of a scratch ticket or the checkbox of an OpenSpec task. Only the status marker changes; the rest of the file stays intact. OpenSpec supports only todo and done.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Task file path relative to the project root.' },
        line: { type: 'integer', description: '1-based line of the checkbox (OpenSpec only).' },
        id: { type: 'string', description: 'Task id from sdd_tasks (scratch tickets).' },
        status: { type: 'string', enum: ['todo', 'doing', 'review', 'done'], description: 'Target kanban column.' },
      },
      required: ['path', 'status'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return textBlock(value?.ok ? `Задача перемещена: ${value.column} (${value.raw})` : `Не удалось: ${value?.error ?? 'ошибка'}`)
      },
    },
    async execute(args, exec) {
      return service.moveTask(exec, args)
    },
  }
}

function tasksTextFor(value) {
  const tasks = value?.tasks
  if (!tasks?.items?.length) return 'Задач нет: у активного изменения не найдено тикетов или чекбоксов.'
  const lines = [`Задачи изменения "${tasks.changeId ?? '—'}" (${tasks.items.length}):`]
  for (const column of ['todo', 'doing', 'review', 'done']) {
    const items = tasks.items.filter((item) => item.kanban === column)
    if (items.length === 0) continue
    lines.push(`- ${column}:`)
    for (const item of items) lines.push(`  - ${item.id}: ${item.title}${item.blockedBy ? ` (блок: ${item.blockedBy})` : ''}`)
  }
  return lines.join('\n')
}

/**
 * `sdd_digest` — weekly digest for the session's project.
 * @param {{ digest: (exec: any, days?: number) => Promise<any> }} service
 */
export function digestTool(service) {
  return {
    name: 'sdd_digest',
    description:
      'Build the SDD weekly digest of the current project: changes archived and started in the window, commits with code versus artifacts, drift files, cycle time, current phase, next step and findings. Use it for a scheduled weekly report or when the user asks what moved this week.',
    parameters: {
      type: 'object',
      properties: {
        days: {
          type: 'integer',
          description: 'Window in days (1–90). Defaults to 7.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return textBlock(value?.markdown || 'Дайджест недоступен.')
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return service.digest(exec, args?.days)
    },
  }
}

/**
 * `sdd_status` — full SDD state of the session's project.
 * @param {{ status: (exec: any) => Promise<any> }} service
 */
export function statusTool(service) {
  return {
    name: 'sdd_status',
    description:
      'Return the spec-driven development (SDD) state of the project the current session works in: detected practice (openspec/scratch), phase, active change, task progress, next step, drift findings, document paths and statistics. Call it before starting implementation, when unsure which SDD step is due, or when the user asks where the work stands.',
    parameters: {
      type: 'object',
      properties: {
        refresh: {
          type: 'boolean',
          description: 'Force a fresh filesystem scan instead of the cached state.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return textBlock(statusTextFor(value))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return service.status(exec, args?.refresh === true)
    },
  }
}

/**
 * `sdd_check` — findings only, for a cheap re-check before finishing.
 * @param {{ check: (exec: any) => Promise<any> }} service
 */
export function checkTool(service) {
  return {
    name: 'sdd_check',
    description:
      'Run the SDD consistency checks for the current project and return only the findings (stale change, pending archive, code changed without an approved spec, unchecked tasks). Use it before reporting work as finished or archiving a change.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return textBlock(checkTextFor(value))
      },
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return service.check(exec, true)
    },
  }
}
