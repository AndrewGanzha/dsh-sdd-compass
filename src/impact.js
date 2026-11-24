/**
 * Impact map: OpenSpec proposals declare the files a change touches under an
 * `## Impact` heading. Parsing that list lets the compass compare the declared
 * surface with the files actually changed or annotated.
 */

/** Normalize one declared entry: no backticks, no trailing punctuation. */
function normalizeEntry(value) {
  return value
    .replace(/[`'"]/g, '')
    .replace(/[.,;:]+$/, '')
    .replace(/\\/g, '/')
}

/** True when a token looks like a file or directory path (not an endpoint/URL). */
function looksLikePath(token) {
  if (!token || /\s/.test(token)) return false
  if (token.startsWith('/') || /^[a-z]+:\/\//i.test(token)) return false
  return token.includes('/') || /\.[a-z0-9]{1,8}$/i.test(token)
}

/**
 * Parse the `## Impact` section of a proposal.
 * @param {string} text - proposal Markdown.
 * @returns {string[]} declared paths (max 50).
 */
export function parseImpact(text) {
  if (!text) return []
  const source = String(text).replace(/\r\n?/g, '\n')
  const paths = []
  let inImpact = false
  for (const line of source.split('\n')) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/)
    if (heading) {
      inImpact = /impact|влиян|затрагиваем|изменяем/i.test(heading[2])
      continue
    }
    if (!inImpact) continue
    const item = line.match(/^\s{0,6}[-*]\s+(.+)$/)
    if (!item) continue
    const declared = [...item[1].matchAll(/`([^`]+)`/g)]
      .map((match) => normalizeEntry(match[1]))
      .filter(looksLikePath)
    if (declared.length > 0) {
      paths.push(...declared)
      continue
    }
    for (const raw of item[1].replace(/\([^)]*\)/g, ' ').split(/[\s,;]+/)) {
      const token = normalizeEntry(raw)
      if (!looksLikePath(token)) continue
      paths.push(token)
    }
  }
  return [...new Set(paths)].slice(0, 50)
}

/**
 * True when a changed file falls under a declared impact entry. Supports an
 * exact path, a directory prefix (`src/api/`), and simple `*` globs.
 */
export function matchesImpact(file, entry) {
  const path = file.replace(/\\/g, '/')
  const target = entry.replace(/\\/g, '/')
  if (target.includes('*')) {
    const pattern = target
      .split('**')
      .map((part) => part.split('*').map((piece) => piece.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
      .join('.*')
    try {
      return new RegExp(`^${pattern}$`).test(path)
    } catch {
      return false
    }
  }
  if (target.endsWith('/')) return path.startsWith(target)
  return path === target || path.startsWith(`${target}/`)
}
