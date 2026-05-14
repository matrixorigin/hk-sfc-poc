import type { Message, SQLResult } from '../types'

export function selectPrimaryResult(message: Message): SQLResult | undefined {
  if (!message.sqlResults?.length) return undefined
  const { chartSpec } = message

  // 1. Prefer chartSpec.round_index match
  if (chartSpec?.round_index !== undefined) {
    const match = message.sqlResults.find((r) => r.round_index === chartSpec.round_index)
    if (match) return match
  }

  // 2. Prefer the latest result that has rows
  const withRows = message.sqlResults.filter((r) => r.rows?.length > 0)
  if (withRows.length) return withRows[withRows.length - 1]

  // 3. Fallback: most columns
  return message.sqlResults.reduce((best, r) =>
    (r.columns?.length ?? 0) > (best.columns?.length ?? 0) ? r : best
  )
}
