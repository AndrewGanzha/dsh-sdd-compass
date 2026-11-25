/**
 * Task board: parse task items out of SDD artifacts, map their native status
 * to kanban columns, and rewrite exactly one status line or checkbox.
 *
 * Writes are deliberately narrow: only the `**Status:**` value of a scratch
 * ticket or the `[ ]`/`[x]` marker of an OpenSpec task line. Everything else in
 * the file is preserved, including line endings.
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

/** Kanban columns in display order. */
export const COLUMNS = ['todo', 'doing', 'review', 'done']

/** Column labels. */
export const COLUMN_LABELS = {
  todo: 'Очередь',
  doing: 'В работе',
  review: 'Проверка',
  done: 'Готово',
}

/** Native statuses written for scratch tickets. */
const SCRATCH_STATUS = {
  todo: 'ready-for-agent',
  doing: 'in-progress',
  review: 'review',
  done: 'done',
}

/** Parse `- [ ] text` / `- [x] text` items from an OpenSpec tasks file. */
export function parseTaskItems(text, filePath = null) {
  if (!text) return []
  const items = []
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s{0,6}[-*]\s+)\[( |x|X)\]\s+(.+?)\s*$/)
    if (!match) continue
    const done = match[2] !== ' '
    items.push({
      id: `T${items.length + 1}`,
      title: match[3],
      done,
      line: index + 1,
      kind: 'checkbox',
      path: filePath,
      status: done ? 'done' : 'todo',
    })
    if (items.length >= 200) break
  }
  return items
}

/** Map a native status to a kanban column. */
export function kanbanOf(practice, rawStatus) {
  const status = String(rawStatus ?? '').toLowerCase()
  if (practice === 'openspec') return status === 'done' ? 'done' : 'todo'
  if (['done', 'completed', 'closed', 'wontfix', 'wont-fix'].includes(status)) return 'done'
  if (['in-progress', 'in_progress'].includes(status)) return 'doing'
  if (['review', 'in-review', 'needs-review'].includes(status)) return 'review'
  return 'todo'
}

/** True when the column is writable for the practice. */
export function isWritable(practice, column) {
  if (practice === 'openspec') return column === 'todo' || column === 'done'
  if (practice === 'scratch') return COLUMNS.includes(column)
  return false
}

/** Split text into lines while keeping the original separators. */
function splitKeepEndings(text) {
  const lines = text.split('\n')
  return lines.map((line, index) => ({ line, last: index === lines.length - 1 }))
}

/** Replace the status value on one scratch ticket line. */
function rewriteScratchStatus(text, column) {
  const target = SCRATCH_STATUS[column]
  if (!target) throw new Error(`Неизвестный статус: ${column}`)
  const parts = text.split(/(\r?\n)/)
  for (let index = 0; index < parts.length; index += 1) {
    const line = parts[index]
    const match = line.match(/^(\s{0,3}(?:[-*]\s*)?\*\*Status:\*\*\s*)([^\s*]+)(.*)$/)
    if (!match) continue
    parts[index] = `${match[1]}${target}${match[3]}`
    return parts.join('')
  }
  throw new Error('В тикете нет строки **Status:**')
}

/** Toggle the checkbox on one OpenSpec task line. */
function rewriteCheckbox(text, lineNumber, column) {
  const parts = text.split(/(\r?\n)/)
  // Content lines live at even indexes: [content, sep, content, sep, …].
  const index = (lineNumber - 1) * 2
  const line = parts[index]
  if (typeof line !== 'string') throw new Error('Строка задачи не найдена')
  const marker = column === 'done' ? 'x' : ' '
  const replaced = line.replace(/\[( |x|X)\]/, `[${marker}]`)
  if (replaced === line && !/\[( |x|X)\]/.test(line)) throw new Error('В строке нет чекбокса')
  parts[index] = replaced
  return parts.join('')
}

/** Ensure the target file stays inside the project root. */
function safePath(root, relative) {
  const absolute = path.resolve(root, relative)
  const normalizedRoot = path.resolve(root)
  if (absolute !== normalizedRoot && !absolute.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error('Путь вне проекта')
  }
  return absolute
}

/**
 * Move one task to a kanban column by rewriting its artifact.
 * @param {{ root: string, practice: string, task: any, column: string }} input
 * @returns {Promise<{ ok: true, column: string, raw: string }>}
 */
export async function setTaskColumn(input) {
  const { root, practice, task, column } = input
  if (!isWritable(practice, column)) throw new Error(`Для ${practice} доступны только очередь и готово`)
  if (!task?.path) throw new Error('У задачи нет пути')

  const absolute = safePath(root, task.path)
  const text = await fsp.readFile(absolute, 'utf8')
  const next =
    practice === 'openspec' ? rewriteCheckbox(text, task.line, column) : rewriteScratchStatus(text, column)
  if (next === text) return { ok: true, column, raw: task.status }

  const temporary = `${absolute}.sdd-tmp`
  await fsp.writeFile(temporary, next, 'utf8')
  await fsp.rename(temporary, absolute)
  return { ok: true, column, raw: practice === 'openspec' ? column : SCRATCH_STATUS[column] }
}
