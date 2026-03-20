import { useRef, useCallback } from 'react'
import type { ExploreEvent, SQLResult, Message } from '../types'

interface UseExploreSSEOptions {
  onUpdate: (updater: (msg: Message) => Message) => void
  onDone: () => void
  onError: (error: string) => void
}

export function useExploreSSE({ onUpdate, onDone, onError }: UseExploreSSEOptions) {
  const abortControllerRef = useRef<AbortController | null>(null)

  const send = useCallback(
    async (question: string, sessionId: string) => {
      // 取消之前的请求
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      const controller = new AbortController()
      abortControllerRef.current = controller

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ question, session_id: sessionId }),
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
          // 保留最后一行（可能不完整）
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
      case 'synthesis.delta': {
        const delta: string = event.data?.delta ?? ''
        onUpdate((msg) => ({ ...msg, content: msg.content + delta }))
        break
      }
      case 'sql.result': {
        const result: SQLResult = {
          columns: event.data?.columns ?? [],
          rows: event.data?.rows ?? [],
          sql: event.data?.sql,
          total_count: event.data?.total_count,
        }
        onUpdate((msg) => ({
          ...msg,
          sqlResults: [...msg.sqlResults, result],
        }))
        break
      }
      case 'sql.generated': {
        const sql: string = event.data?.sql ?? ''
        if (sql) {
          onUpdate((msg) => ({
            ...msg,
            sqlStatements: [...msg.sqlStatements, sql],
          }))
        }
        break
      }
      case 'run.error': {
        const errMsg: string = event.data?.message ?? event.data?.error ?? 'Unknown error'
        onUpdate((msg) => ({ ...msg, error: errMsg }))
        onError(errMsg)
        break
      }
      case 'run.completed':
      case 'synthesis.done': {
        onUpdate((msg) => ({ ...msg, isStreaming: false }))
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
