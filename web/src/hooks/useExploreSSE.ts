import { useRef, useCallback } from 'react'
import type { ExploreEvent, SQLResult, Message } from '../types'

/**
 * Strip JSON wrapper from synthesis output.
 * Dev explore outputs {"answer": "...", "sources": [...]}.
 * Truncation continuation may produce multiple JSON objects concatenated.
 */
function stripJsonWrapper(text: string): string {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith('{')) return text

  const parts: string[] = []
  const re = /"answer"\s*:\s*"/g
  let match
  while ((match = re.exec(trimmed)) !== null) {
    const start = match.index + match[0].length
    let end = start
    let escaped = false
    for (let i = start; i < trimmed.length; i++) {
      if (escaped) { escaped = false; continue }
      if (trimmed[i] === '\\') { escaped = true; continue }
      if (trimmed[i] === '"') { end = i; break }
    }
    if (end > start) {
      parts.push(trimmed.slice(start, end))
    } else {
      parts.push(trimmed.slice(start))
    }
  }

  if (parts.length === 0) {
    if (trimmed.length < 15) return ''
    return text
  }

  return parts.join('')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

interface UseExploreSSEOptions {
  onUpdate: (updater: (msg: Message) => Message) => void
  onDone: () => void
  onError: (error: string) => void
}

export function useExploreSSE({ onUpdate, onDone, onError }: UseExploreSSEOptions) {
  const abortControllerRef = useRef<AbortController | null>(null)

  const send = useCallback(
    async (question: string, sessionId: string, tables?: string[]) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      const controller = new AbortController()
      abortControllerRef.current = controller

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question, session_id: sessionId, ...(tables?.length ? { tables } : {}) }),
          signal: controller.signal,
        })

        if (!response.ok) {
          onError(`HTTP error: ${response.status}`)
          return
        }

        const reader = response.body?.getReader()
        if (!reader) {
          onError('No response body')
          return
        }

        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith('data:')) continue
            const jsonStr = trimmed.slice(5).trim()
            if (!jsonStr) continue

            let event: ExploreEvent
            try {
              event = JSON.parse(jsonStr)
            } catch {
              continue
            }
            handleEvent(event)
          }
        }
      } catch (err: any) {
        if (err?.name === 'AbortError') return
        onError(err?.message ?? 'Unknown error')
      }
    },
    [onUpdate, onDone, onError]
  )

  function handleEvent(event: ExploreEvent) {
    switch (event.event) {
      case 'run.started': {
        onUpdate((msg) => ({ ...msg, phase: 'thinking' }))
        break
      }
      case 'planning.plan.ready':
      case 'planning.rewrite.ready': {
        onUpdate((msg) => ({ ...msg, phase: 'planning' }))
        break
      }
      case 'sql.schema.ready':
      case 'sql.generated': {
        // Update phase on sql.generated but don't store SQL yet — wait for sql.result which has the actually executed SQL
        if (event.event === 'sql.generated') {
          onUpdate((msg) => ({ ...msg, phase: 'querying' }))
        } else {
          onUpdate((msg) => ({ ...msg, phase: msg.phase === 'thinking' ? 'planning' : msg.phase }))
        }
        break
      }
      case 'retrieval.progress': {
        onUpdate((msg) => ({ ...msg, phase: 'querying' }))
        break
      }
      case 'sql.result': {
        onUpdate((msg) => ({ ...msg, phase: 'querying' }))
        // Store the actually executed SQL (may differ from sql.generated if repair happened)
        const executedSQL: string = event.data?.sql ?? ''
        if (executedSQL) {
          onUpdate((msg) => ({
            ...msg,
            sqlStatements: msg.sqlStatements.includes(executedSQL)
              ? msg.sqlStatements
              : [...msg.sqlStatements, executedSQL],
          }))
        }
        const result: SQLResult = {
          columns: event.data?.columns ?? [],
          rows: event.data?.rows ?? [],
          sql: event.data?.sql,
          total_count: event.data?.total_count,
          round_index: event.data?.round_index,
        }
        // Keep only the result with the most columns (most detailed).
        // If a new result has more columns, replace; if same or fewer, skip.
        onUpdate((msg) => {
          const colSig = JSON.stringify(result.columns)
          // Skip exact duplicates (same columns + same row count)
          const isDup = msg.sqlResults.some(
            (r) => JSON.stringify(r.columns) === colSig && r.rows.length === result.rows.length
          )
          if (isDup) return msg

          // If existing result is a subset (fewer columns, similar data), replace it
          const filtered = msg.sqlResults.filter(
            (r) => !(r.rows.length === result.rows.length && r.columns.length < result.columns.length)
          )
          // If new result is a subset of existing, skip
          const isSubset = msg.sqlResults.some(
            (r) => r.rows.length === result.rows.length && r.columns.length >= result.columns.length
          )
          if (isSubset) return msg

          return { ...msg, sqlResults: [...filtered, result] }
        })
        break
      }
      case 'chart.recommendation': {
        const spec = event.data
        if (spec) {
          onUpdate((msg) => ({
            ...msg,
            chartSpec: {
              chart_type: spec.chart_type ?? 'auto',
              x: spec.x,
              y: spec.y,
              display_mode: spec.display_mode ?? 'both',
              round_index: spec.round_index,
            },
          }))
        }
        break
      }
      case 'synthesis.delta': {
        const delta: string = event.data?.delta ?? ''
        onUpdate((msg) => {
          const raw = (msg as any)._rawContent ?? msg.content
          const newRaw = raw + delta
          return { ...msg, phase: 'answering', content: stripJsonWrapper(newRaw), _rawContent: newRaw } as any
        })
        break
      }
      case 'run.error': {
        const errMsg: string = event.data?.message ?? event.data?.error ?? 'Unknown error'
        // Only surface non-recoverable errors or if it's the final error
        if (event.data?.recoverable === false) {
          onUpdate((msg) => ({ ...msg, error: errMsg }))
          onError(errMsg)
        }
        break
      }
      case 'synthesis.done': {
        onUpdate((msg) => {
          const m = { ...msg, isStreaming: false, phase: 'done' } as any
          delete m._rawContent
          return m
        })
        onDone()
        break
      }
      case 'run.completed': {
        onUpdate((msg) => ({
          ...msg,
          isStreaming: false,
          phase: 'done',
          // If completed with failed status and no content, show error
          ...(event.data?.status === 'failed' && !msg.content
            ? { error: 'Query failed. Please try rephrasing your question.' }
            : {}),
        }))
        onDone()
        break
      }
      default:
        break
    }
  }

  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
  }, [])

  return { send, cancel }
}
