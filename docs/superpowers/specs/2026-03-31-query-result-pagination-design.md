# Query Result Pagination Design

**Date**: 2026-03-31
**Status**: Approved (reviewed by Claude + Codex, 3 rounds)

## Problem

SQL query results (80~1000+ rows) are only partially shown as markdown bullet lists in the AI text response. Users cannot see all rows. The existing `DataTable.tsx` component is unused and has no pagination.

## Solution

Pure frontend pagination. No backend changes. Use the full `sql.result` data already available in `Message.sqlResults[]`, render in a paginated DataTable below the chart.

## Design

### 1. Shared Helper: `selectPrimaryResult(message)`

New file: `web/src/utils/selectPrimaryResult.ts`

Extracts result selection logic into a shared utility used by Chart, DataTable, and FeedbackButton:

```typescript
function selectPrimaryResult(message: Message): SQLResult | undefined {
  if (!message.sqlResults.length) return undefined
  const { chartSpec } = message

  // 1. Prefer chartSpec.round_index match
  if (chartSpec?.round_index !== undefined) {
    const match = message.sqlResults.find(r => r.round_index === chartSpec.round_index)
    if (match) return match
  }

  // 2. Prefer the latest result that has rows
  const withRows = message.sqlResults.filter(r => r.rows.length > 0)
  if (withRows.length) return withRows[withRows.length - 1]

  // 3. Fallback: most columns
  return message.sqlResults.reduce((best, r) =>
    r.columns.length > best.columns.length ? r : best
  )
}
```

Replaces the inline selection logic currently duplicated in MessageBubble (chart section and feedback section).

### 2. DataTable.tsx — Full Rewrite

**Props**: `{ result: SQLResult }`

**State**:
- `page`: number, default 1
- `pageSize`: number, default 20

**Pagination logic**:
- `totalRows = result.total_count ?? result.rows.length`
- `totalPages = Math.ceil(result.rows.length / pageSize)`
- `displayRows = result.rows.slice((page-1)*pageSize, page*pageSize)`
- Defensive clamp: `page = Math.min(page, totalPages)` to prevent empty pages

**Cell rendering** — iterate by `columns` index, not by `row` array:
```tsx
columns.map((_, ci) => <td key={ci}>{row[ci] ?? ''}</td>)
```
This prevents header/body misalignment when rows have missing or extra elements.

**Pagination reset triggers**:
- When `pageSize` changes → reset to page 1
- When result changes → reset to page 1, using derived key: `${result.round_index}_${result.columns.length}_${result.rows.length}`

**Pagination UI** (below table, inside `.data-table-wrapper`):
- Left: page size selector dropdown (20 / 50 / 100)
- Center: First / Prev / "Page M of N" / Next / Last buttons
- Right: "Rows X-Y of Z" info text
- Hidden when `result.rows.length <= pageSize`

### 3. MessageBubble.tsx — Wire In DataTable

Rendering order for assistant messages (when `isDone`):

```
Markdown content
  ↓
Chart (if chartSpec not 'none' and primaryResult has rows)
  ↓
DataTable (if primaryResult has rows)          ← NEW
  ↓
SQL toggle (if sqlStatements exist)
  ↓
FeedbackButton (if primaryResult exists)
```

All three consumers (Chart, DataTable, FeedbackButton) call `selectPrimaryResult(message)` once at the top and share the result.

### 4. i18n — Template-Based Translations

New function `tpl(key, params)` in `web/src/i18n/index.ts` — does `{placeholder}` replacement. Existing `t()` signature unchanged.

**en.json additions**:
```json
"tableRange": "Rows {start}-{end} of {total}",
"tablePageIndicator": "Page {page} of {pages}",
"tableRowsPerPage": "Rows per page"
```

**zh.json additions**:
```json
"tableRange": "第 {start}-{end} 行，共 {total} 行",
"tablePageIndicator": "第 {page} 页 / 共 {pages} 页",
"tableRowsPerPage": "每页行数"
```

### 5. App.css — Pagination Styles

```css
.data-table-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  background: #f8fafc;
  border-top: 1px solid #e4e7ec;
  font-size: 12px;
  color: #64748b;
}

.pagination-btn {
  padding: 4px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  font-size: 12px;
  color: #475569;
}

.pagination-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.pagination-btn:hover:not(:disabled) {
  background: #f1f5f9;
  border-color: #cbd5e1;
}

.page-size-select {
  padding: 4px 8px;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 12px;
  color: #475569;
  background: #fff;
}

.pagination-info {
  font-size: 12px;
  color: #94a3b8;
}
```

## Files to Modify

| File | Change |
|------|--------|
| `web/src/utils/selectPrimaryResult.ts` | **NEW**: shared result selection helper |
| `web/src/components/DataTable.tsx` | Rewrite: pagination + column-based cell rendering |
| `web/src/components/MessageBubble.tsx` | Add DataTable, refactor to use selectPrimaryResult |
| `web/src/i18n/index.ts` | Add `tpl()` template interpolation function |
| `web/src/i18n/en.json` | Add 3 pagination translation templates |
| `web/src/i18n/zh.json` | Add 3 pagination translation templates |
| `web/src/App.css` | Add pagination control styles |

## Edge Cases

| Case | Behavior |
|------|----------|
| 0 rows | Show "No data" message (existing) |
| rows <= pageSize | No pagination controls, show all rows |
| Streaming in progress | No DataTable (guarded by `isDone`) |
| Multiple sqlResults | `selectPrimaryResult` handles consistently |
| Page out of bounds | Defensive clamp + reset on result/pageSize change |
| Wide tables (many columns) | Existing horizontal scroll preserved |
| total_count vs rows.length | Display uses `total_count ?? rows.length`, pagination uses `rows.length` |

## What Changes / What Doesn't

**Changed**:
- DataTable now rendered in MessageBubble with pagination
- Chart and Feedback refactored to use shared `selectPrimaryResult` — semantics slightly adjusted for consistency (prefer latest result with rows over most-columns)

**Unchanged**:
- Backend: zero changes
- SSE protocol: unchanged
- Data flow: unchanged (frontend still receives full rows via SSE)
