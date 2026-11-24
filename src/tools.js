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
 * `sdd_search` — internal search over the panel's content.
 * @param {{ search: (query: string, cwd: string|null) => Promise<any> }} service
 */
export function searchTool(service) {
  return {
    name: 'sdd_search',
    description:
      'Search the current project SDD content: changes, documents, change artifacts and findings, plus known workspace projects. Use it to find the spec or doc that mentions a module, a change name, or a finding.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Case-insensitive substring, at least 2 characters.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render(_args, value) {
        return textBlock(searchTextFor(value))
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const cwd = exec?.agent?.session?.header?.cwd ?? null
      return service.search(args.query, cwd)
    },
  }
}

function searchTextFor(value) {
  if (!value?.results?.length) return `Ничего не найдено по «${value?.query ?? ''}».`
  return [
    `Найдено: ${value.results.length}`,
    ...value.results.map((row) => `- ${row.kind}: ${row.title}${row.path ? ` (${row.path})` : ''}`),
  ].join('\n')
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
