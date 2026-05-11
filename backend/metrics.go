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
		reg.byFull[def.Column] = def
		bare := def.Column
		if idx := strings.LastIndex(bare, "."); idx >= 0 {
			bare = bare[idx+1:]
		}
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
	hits := map[string]*MetricDef{}

	// 第一遍：按 table.column 精确匹配，优先级最高
	for full, def := range r.byFull {
		// 把 table.column 转为大小写不敏感子串匹配
		if containsFold(sql, full) {
			hits[def.Column] = def
		}
	}

	// 第二遍：按 bare column 一次性正则扫
	matches := r.bareRegex.FindAllString(sql, -1)
	for _, m := range matches {
		bare := strings.ToLower(m)
		// byBare 的 key 与原始 yaml 中的列名（已小写）保持一致
		// 但 yaml 列名大小写敏感，因此先用原大小写查；找不到则统一小写再查
		defs, ok := r.byBare[m]
		if !ok {
			// 按原始 key 大小写匹配（如 ma_3）
			for k, v := range r.byBare {
				if strings.EqualFold(k, bare) {
					defs = v
					ok = true
					break
				}
			}
		}
		if !ok {
			continue
		}
		// 同名列出现在多个表时，全部加入（无法从 SQL 文本判定具体哪张表，保守取并集）
		for _, d := range defs {
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
	hits := map[string]*MetricDef{}
	for _, c := range cols {
		// 优先精确 bare 匹配
		if defs, ok := r.byBare[c]; ok {
			for _, d := range defs {
				hits[d.Column] = d
			}
			continue
		}
		// 不区分大小写
		for k, v := range r.byBare {
			if strings.EqualFold(k, c) {
				for _, d := range v {
					hits[d.Column] = d
				}
				break
			}
		}
	}
	return collectSorted(hits)
}

// MatchSQLAndColumns 合并 SQL 文本匹配与结果列匹配，返回去重后的 metric 列表。
func (r *MetricRegistry) MatchSQLAndColumns(sql string, cols []string) []MetricDef {
	if r == nil {
		return nil
	}
	merged := map[string]MetricDef{}
	for _, m := range r.MatchSQL(sql) {
		merged[m.Column] = m
	}
	for _, m := range r.MatchColumns(cols) {
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
