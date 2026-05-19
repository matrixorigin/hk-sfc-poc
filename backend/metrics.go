package main

import (
	"fmt"
	"os"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// MetricDef 一条预计算列的可解释性说明，对应 backend/metrics.yaml 的每个条目。
type MetricDef struct {
	Column  string `yaml:"column" json:"column"`
	Name    string `yaml:"name" json:"name"`
	Explain string `yaml:"explain" json:"explain"`
	Code    string `yaml:"code" json:"code"`
	Source  string `yaml:"source" json:"source"`
}

// MetricRegistry 提供按 SQL 文本或结果列名匹配 metric 的能力。
type MetricRegistry struct {
	all    []MetricDef
	byFull map[string]*MetricDef   // "table.column" → 单条
	byBare map[string][]*MetricDef // "column" → 多条（同名列在不同表）
	// 一次性正则：匹配所有 bare column，避免每条都跑一次正则。
	bareRegex *regexp.Regexp
	// bareRegex 的捕获组顺序对应 bareNames 列表
	bareNames []string
}

type metricsFile struct {
	Metrics []MetricDef `yaml:"metrics"`
}

// LoadMetrics 从指定路径读取 metrics.yaml，并构建匹配索引。
// 若条目缺字段（5 个全部必填）直接返回错误，让进程启动失败 fail-fast。
func LoadMetrics(path string) (*MetricRegistry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read metrics file: %w", err)
	}
	var f metricsFile
	if err := yaml.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("parse metrics yaml: %w", err)
	}
	if len(f.Metrics) == 0 {
		return nil, fmt.Errorf("metrics yaml has no entries")
	}

	reg := &MetricRegistry{
		byFull: make(map[string]*MetricDef),
		byBare: make(map[string][]*MetricDef),
	}
	seen := map[string]bool{}
	bareSet := map[string]bool{}

	for i := range f.Metrics {
		m := f.Metrics[i]
		if m.Column == "" || m.Name == "" || m.Explain == "" || m.Code == "" || m.Source == "" {
			return nil, fmt.Errorf("metrics yaml entry #%d missing required field: %+v", i, m)
		}
		if seen[m.Column] {
			return nil, fmt.Errorf("metrics yaml duplicate column: %s", m.Column)
		}
		seen[m.Column] = true
		reg.all = append(reg.all, m)
	}

	// 构建索引（指向 reg.all 的元素）
	for i := range reg.all {
		def := &reg.all[i]
		reg.byFull[strings.ToLower(def.Column)] = def
		bare := def.Column
		if idx := strings.LastIndex(bare, "."); idx >= 0 {
			bare = bare[idx+1:]
		}
		bare = strings.ToLower(bare)
		reg.byBare[bare] = append(reg.byBare[bare], def)
		bareSet[bare] = true
	}

	// 构建一次性 bare 列名正则：\b(col1|col2|...)\b（不区分大小写）
	for bare := range bareSet {
		reg.bareNames = append(reg.bareNames, bare)
	}
	sort.Strings(reg.bareNames) // 顺序稳定
	if len(reg.bareNames) > 0 {
		escaped := make([]string, len(reg.bareNames))
		for i, n := range reg.bareNames {
			escaped[i] = regexp.QuoteMeta(n)
		}
		reg.bareRegex = regexp.MustCompile(`(?i)\b(` + strings.Join(escaped, "|") + `)\b`)
	}

	return reg, nil
}

// MatchSQL 扫描 SQL 文本，返回所有命中的 metric，按 Column 字典序去重。
func (r *MetricRegistry) MatchSQL(sql string) []MetricDef {
	if r == nil || r.bareRegex == nil {
		return nil
	}
	tables, aliases := extractSQLTables(sql)
	hits := map[string]*MetricDef{}

	// 第一遍：按 table.column 精确匹配，优先级最高
	for full, def := range r.byFull {
		// 把 table.column 转为大小写不敏感子串匹配
		if containsFold(sql, full) {
			hits[def.Column] = def
		}
	}

	// 第二遍：按 alias.column / table.column 匹配，解决 SELECT t.ma_50 这类写法。
	qualifiedRegex := regexp.MustCompile(`(?i)\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b`)
	for _, m := range qualifiedRegex.FindAllStringSubmatch(sql, -1) {
		tableOrAlias := strings.ToLower(m[1])
		column := strings.ToLower(m[2])
		table := tableOrAlias
		if resolved, ok := aliases[tableOrAlias]; ok {
			table = resolved
		}
		if def, ok := r.byFull[table+"."+column]; ok {
			hits[def.Column] = def
		}
	}

	// 第三遍：按 bare column 扫，但只保留本 SQL 实际引用表上的定义。
	// 这避免 trade_date 一命中就把个股、恒指、公告三张表的解释都展示出来。
	matches := r.bareRegex.FindAllString(sql, -1)
	for _, m := range matches {
		bare := strings.ToLower(m)
		defs, ok := r.byBare[bare]
		if !ok {
			continue
		}
		scoped := filterDefsByTables(defs, tables)
		if len(scoped) == 0 {
			continue
		}
		for _, d := range scoped {
			hits[d.Column] = d
		}
	}

	return collectSorted(hits)
}

// MatchColumns 用 sql.result 返回的列名做补充匹配，捕获 SQL 文本中已被 alias 但
// 底层仍是预计算列的场景（少见，但作为兜底）。
func (r *MetricRegistry) MatchColumns(cols []string) []MetricDef {
	if r == nil {
		return nil
	}
	return r.matchColumnsScoped(cols, nil)
}

func (r *MetricRegistry) matchColumnsScoped(cols []string, tables map[string]bool) []MetricDef {
	hits := map[string]*MetricDef{}
	for _, c := range cols {
		// 优先精确 bare 匹配
		if defs, ok := r.byBare[strings.ToLower(c)]; ok {
			scoped := filterDefsByTables(defs, tables)
			if len(scoped) == 1 {
				hits[scoped[0].Column] = scoped[0]
			}
			continue
		}
	}
	return collectSorted(hits)
}

// MatchSQLAndColumns 合并 SQL 文本匹配与结果列匹配，返回去重后的 metric 列表。
func (r *MetricRegistry) MatchSQLAndColumns(sql string, cols []string) []MetricDef {
	if r == nil {
		return nil
	}
	tables, _ := extractSQLTables(sql)
	merged := map[string]MetricDef{}
	for _, m := range r.MatchSQL(sql) {
		merged[m.Column] = m
	}
	for _, m := range r.matchColumnsScoped(cols, tables) {
		merged[m.Column] = m
	}
	if len(merged) == 0 {
		return nil
	}
	out := make([]MetricDef, 0, len(merged))
	for _, m := range merged {
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Column < out[j].Column })
	return out
}

func collectSorted(hits map[string]*MetricDef) []MetricDef {
	if len(hits) == 0 {
		return nil
	}
	out := make([]MetricDef, 0, len(hits))
	for _, d := range hits {
		out = append(out, *d)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Column < out[j].Column })
	return out
}

func containsFold(s, sub string) bool {
	return strings.Contains(strings.ToLower(s), strings.ToLower(sub))
}

func metricTable(column string) string {
	if idx := strings.LastIndex(column, "."); idx >= 0 {
		return strings.ToLower(column[:idx])
	}
	return ""
}

func filterDefsByTables(defs []*MetricDef, tables map[string]bool) []*MetricDef {
	if len(defs) == 0 {
		return nil
	}
	if len(tables) == 0 {
		if len(defs) == 1 {
			return defs
		}
		return nil
	}
	out := make([]*MetricDef, 0, len(defs))
	for _, d := range defs {
		if tables[metricTable(d.Column)] {
			out = append(out, d)
		}
	}
	return out
}

func extractSQLTables(sql string) (map[string]bool, map[string]string) {
	tables := map[string]bool{}
	aliases := map[string]string{}
	re := regexp.MustCompile(`(?i)\b(from|join|update|into)\s+([a-z_][a-z0-9_]*)(?:\s+(?:as\s+)?([a-z_][a-z0-9_]*))?`)
	stopWords := map[string]bool{
		"where": true, "join": true, "on": true, "group": true, "order": true,
		"having": true, "limit": true, "left": true, "right": true, "inner": true,
		"outer": true, "cross": true, "full": true, "set": true, "values": true,
	}
	for _, m := range re.FindAllStringSubmatch(sql, -1) {
		table := strings.ToLower(m[2])
		tables[table] = true
		aliases[table] = table
		if len(m) > 3 && m[3] != "" {
			alias := strings.ToLower(m[3])
			if !stopWords[alias] {
				aliases[alias] = table
			}
		}
	}
	return tables, aliases
}
