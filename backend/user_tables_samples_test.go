package main

import (
	"path/filepath"
	"reflect"
	"testing"
)

func TestGuideSampleFilesAreImportable(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		file       string
		sheet      string
		rows       int
		columns    []string
		columnType []string
	}{
		{
			name:  "daily stock CSV",
			file:  "hk-stock-daily-sample.csv",
			sheet: "hk-stock-daily-sample.csv",
			rows:  15,
			columns: []string{
				"trade_date", "stock_code", "stock_name", "close_price_hkd", "daily_change_pct", "volume",
			},
			columnType: []string{
				"DATE", "VARCHAR(255)", "VARCHAR(255)", "DECIMAL(18,6)", "DECIMAL(18,6)", "BIGINT",
			},
		},
		{
			name:  "quarterly financial XLSX",
			file:  "hk-company-financials-sample.xlsx",
			sheet: "Financials",
			rows:  12,
			columns: []string{
				"report_date", "stock_code", "company_name", "industry_name", "revenue_hkd_mn", "gross_profit_hkd_mn", "net_profit_hkd_mn", "eps_hkd",
			},
			columnType: []string{
				"DATE", "VARCHAR(255)", "VARCHAR(255)", "VARCHAR(255)", "DECIMAL(18,6)", "DECIMAL(18,6)", "DECIMAL(18,6)", "DECIMAL(18,6)",
			},
		},
	}

	service := &UserTableService{}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			preview, err := service.PreviewFile(filepath.Join("..", "web", "public", "samples", tc.file))
			if err != nil {
				t.Fatalf("preview sample: %v", err)
			}
			if preview.SheetName != tc.sheet {
				t.Fatalf("sheet name = %q, want %q", preview.SheetName, tc.sheet)
			}
			if preview.TotalRows != tc.rows {
				t.Fatalf("row count = %d, want %d", preview.TotalRows, tc.rows)
			}

			columns := make([]string, len(preview.Columns))
			columnTypes := make([]string, len(preview.Columns))
			for i, column := range preview.Columns {
				columns[i] = column.Name
				columnTypes[i] = column.InferredType
			}
			if !reflect.DeepEqual(columns, tc.columns) {
				t.Fatalf("columns = %#v, want %#v", columns, tc.columns)
			}
			if !reflect.DeepEqual(columnTypes, tc.columnType) {
				t.Fatalf("column types = %#v, want %#v", columnTypes, tc.columnType)
			}
		})
	}
}
