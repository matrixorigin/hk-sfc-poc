package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBuildFeaturePackageContainsRunnableAssets(t *testing.T) {
	manifest := featurePackageManifest{
		GeneratedAt: "2026-06-04T00:00:00Z",
		Question:    "test question",
		SQL:         "SELECT s.avg_vol_30d FROM ms_t_stk_sis s",
		Columns:     []string{"avg_vol_30d"},
		Metrics: []MetricDef{{
			Column:  "ms_t_stk_sis.avg_vol_30d",
			Name:    "30日平均成交量",
			Explain: "x",
			Code:    "y",
			Source:  "scripts/02_import_data.sh#L417-L432",
		}},
		Coverage: []string{"ms_t_stk_sis.avg_vol_30d"},
		Run:      []string{"python3 run.py --mode export --output output/features"},
		Verify:   []string{"python3 run.py --mode verify --output output/features"},
		Apply:    []string{"python3 run.py --mode apply --output output/features --yes"},
	}

	data, err := buildFeaturePackage(manifest)
	if err != nil {
		t.Fatalf("build package: %v", err)
	}
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("read zip: %v", err)
	}
	files := map[string]string{}
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open %s: %v", f.Name, err)
		}
		b, err := io.ReadAll(rc)
		_ = rc.Close()
		if err != nil {
			t.Fatalf("read %s: %v", f.Name, err)
		}
		files[f.Name] = string(b)
	}

	for _, name := range []string{"README.md", "manifest.json", "query.sql", "run.py", "run.sh"} {
		if files[name] == "" {
			t.Fatalf("missing %s in zip", name)
		}
	}
	if !strings.Contains(files["run.py"], "def verify_all") {
		t.Fatalf("run.py does not contain verification implementation")
	}
	if strings.TrimSpace(files["query.sql"]) != manifest.SQL {
		t.Fatalf("query.sql mismatch: %q", files["query.sql"])
	}
	if !strings.Contains(files["README.md"], "./run.sh") {
		t.Fatalf("README should make one-click run the primary path")
	}
	if !strings.Contains(files["run.sh"], "--mode run") {
		t.Fatalf("run.sh should use one-click run mode")
	}

	var got featurePackageManifest
	if err := json.Unmarshal([]byte(files["manifest.json"]), &got); err != nil {
		t.Fatalf("parse manifest: %v", err)
	}
	if got.Metrics[0].Column != "ms_t_stk_sis.avg_vol_30d" {
		t.Fatalf("manifest metrics not preserved: %+v", got.Metrics)
	}
}

func TestFeatureReproductionHandlerServesScript(t *testing.T) {
	handler := NewFeatureReproductionHandler(nil)
	req := httptest.NewRequest(http.MethodGet, "/api/feature-reproduction/script", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "def run_one_click") {
		t.Fatalf("script endpoint did not return full reproduction script")
	}
	if got := rec.Header().Get("Content-Type"); !strings.Contains(got, "text/x-python") {
		t.Fatalf("unexpected content type: %s", got)
	}
}

func TestFeatureReproductionHandlerServesColumnScript(t *testing.T) {
	handler := NewFeatureReproductionHandler(nil)
	req := httptest.NewRequest(http.MethodGet, "/api/feature-reproduction/script?column=ms_t_stk_sis.avg_vol_30d", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "compute_sis_features") {
		t.Fatalf("column script did not return SIS feature implementation")
	}
	if !strings.Contains(body, "UPDATE ms_t_stk_sis") || !strings.Contains(body, "SET trade_date") {
		t.Fatalf("column script should include SIS trade_date preparation before Python precompute")
	}
	if strings.Contains(body, "def run_one_click") {
		t.Fatalf("column script should not return the full reproduction script")
	}
	if got := rec.Header().Get("Content-Disposition"); !strings.Contains(got, "ms_t_stk_sis_avg_vol_30d.txt") {
		t.Fatalf("unexpected content disposition: %s", got)
	}
}

func TestFeatureReproductionHandlerServesSQLForSQLColumn(t *testing.T) {
	handler := NewFeatureReproductionHandler(nil)
	req := httptest.NewRequest(http.MethodGet, "/api/feature-reproduction/script?column=ms_t_stk_sis.trade_date", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{"UPDATE ms_t_stk_sis", "SET trade_date", "WHERE trade_date IS NULL"} {
		if !strings.Contains(body, want) {
			t.Fatalf("SQL column script missing %q", want)
		}
	}
	if strings.Contains(body, "def ") || strings.Contains(body, "return \"\"\"") {
		t.Fatalf("SQL column script should not be wrapped in Python")
	}
	if got := rec.Header().Get("Content-Disposition"); !strings.Contains(got, "ms_t_stk_sis_trade_date.sql") {
		t.Fatalf("unexpected content disposition: %s", got)
	}
	if got := rec.Header().Get("Content-Type"); !strings.Contains(got, "text/plain") {
		t.Fatalf("unexpected content type: %s", got)
	}
}

func TestFeatureReproductionHandlerUsesTableLevelHSIDailyScript(t *testing.T) {
	handler := NewFeatureReproductionHandler(nil)
	req := httptest.NewRequest(http.MethodGet, "/api/feature-reproduction/script?column=ms_v_stk_hsi_daily.trade_date", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "CREATE TABLE IF NOT EXISTS ms_v_stk_hsi_daily") || !strings.Contains(body, "INSERT INTO ms_v_stk_hsi_daily") || !strings.Contains(body, "hsi_pct_change") {
		t.Fatalf("HSI daily script should reproduce the whole derived table")
	}
	if got := rec.Header().Get("Content-Disposition"); !strings.Contains(got, "ms_v_stk_hsi_daily.sql") {
		t.Fatalf("unexpected content disposition: %s", got)
	}
}

func TestFeatureReproductionHandlerServesTableScript(t *testing.T) {
	handler := NewFeatureReproductionHandler(nil)
	req := httptest.NewRequest(http.MethodGet, "/api/feature-reproduction/script?table=ms_t_stk_sis&columns=ms_t_stk_sis.avg_vol_30d,ms_t_stk_sis.ma_20", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "compute_sis_features") || !strings.Contains(body, "avg_vol_30d") {
		t.Fatalf("table script should return table-level SIS precompute script")
	}
	if !strings.Contains(body, "UPDATE ms_t_stk_sis") || !strings.Contains(body, "SET trade_date") {
		t.Fatalf("table script should include SIS trade_date preparation before Python precompute")
	}
	if got := rec.Header().Get("Content-Disposition"); !strings.Contains(got, "ms_t_stk_sis.txt") {
		t.Fatalf("unexpected content disposition: %s", got)
	}
}

func TestFeatureReproductionHandlerServesStructuredTableScript(t *testing.T) {
	handler := NewFeatureReproductionHandler(nil)
	req := httptest.NewRequest(http.MethodGet, "/api/feature-reproduction/script?table=ms_t_stk_sis&columns=ms_t_stk_sis.avg_vol_30d,ms_t_stk_sis.ma_20&format=json", nil)
	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Fatalf("unexpected content type: %s", got)
	}
	var got featureScriptResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("parse response: %v", err)
	}
	if got.Table != "ms_t_stk_sis" || got.Filename != "ms_t_stk_sis.txt" {
		t.Fatalf("unexpected response metadata: %+v", got)
	}
	if len(got.Sections) != 2 {
		t.Fatalf("expected SQL and Python sections, got %+v", got.Sections)
	}
	if got.Sections[0].Language != "sql" || !strings.Contains(got.Sections[0].Body, "UPDATE ms_t_stk_sis") {
		t.Fatalf("first section should be SIS trade_date SQL: %+v", got.Sections[0])
	}
	if got.Sections[1].Language != "python" || !strings.Contains(got.Sections[1].Body, "compute_sis_features") {
		t.Fatalf("second section should be SIS feature Python: %+v", got.Sections[1])
	}
}
