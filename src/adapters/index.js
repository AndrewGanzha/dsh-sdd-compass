/**
 * Adapter dispatch: one practice-specific reader, one uniform change shape.
 */

import { readOpenspec } from './openspec.js'
import { readScratch } from './scratch.js'
import { readSsc } from './ssc.js'

/**
 * Read the changes of a project for its detected practice.
 * @param {string} root - project root.
 * @param {string} practice - detected practice id.
 * @returns {Promise<{ changes: any[], supported: boolean, archivedCount: number, note?: string }>}
 */
export async function readChanges(root, practice) {
  if (practice === 'openspec') {
    const result = await readOpenspec(root)
    return { changes: result.changes, supported: true, archivedCount: result.archivedCount }
  }
  if (practice === 'scratch') {
    const result = await readScratch(root)
    return { changes: result.changes, supported: true, archivedCount: 0 }
  }
  if (practice === 'ssc') {
    const result = await readSsc(root)
    return { changes: result.changes, supported: true, archivedCount: 0 }
  }
  return {
    changes: [],
    supported: false,
    archivedCount: 0,
    note: 'Практика SDD не распознана',
  }
}
