package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func main() {
	configPath := flag.String("config", "config.yaml", "path to config file")
	flag.Parse()

	cfg, err := LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	client := NewExploreClient(cfg.Catalog.URL, cfg.Catalog.APIKey)
	clarifier := NewClarifier(cfg.Catalog.URL, cfg.Catalog.APIKey, cfg.Catalog.WorkspaceID, cfg.Explore.LLMModel)
	chatHandler := &ChatHandler{client: client, clarify: clarifier, cfg: cfg, sessionMap: make(map[string]string)}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/chat", chatHandler.ServeHTTP)
	mux.HandleFunc("/api/tables", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		tables := []map[string]string{
			{"name": "ms_v_stk_hsi_daily", "label": "恒生指数日线 / HSI Daily"},
			{"name": "ms_t_stk_sis", "label": "个股行情 / Stock Trading"},
			{"name": "ms_v_stock_capital", "label": "市值数据 / Market Cap"},
			{"name": "ds_t_int_hsicl_dtl", "label": "行业分类 / Industry Classification"},
			{"name": "sehknews", "label": "新闻公告 / News"},
			{"name": "profit_loss", "label": "财务报表 / Financial Statements"},
			{"name": "ccass_holdings", "label": "CCASS持仓 / CCASS Holdings"},
		}
		json.NewEncoder(w).Encode(tables)
	})

	knowledgeHandler := NewKnowledgeHandler(cfg)
	mux.Handle("/api/knowledge/", knowledgeHandler)
	mux.Handle("/api/knowledge", knowledgeHandler)

	if cfg.Server.StaticDir != "" {
		absDir, _ := filepath.Abs(cfg.Server.StaticDir)
		log.Printf("serving frontend from %s", absDir)
		fs := http.FileServer(http.Dir(absDir))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			filePath := filepath.Join(absDir, r.URL.Path)
			if info, err := os.Stat(filePath); err != nil || info.IsDir() {
				http.ServeFile(w, r, filepath.Join(absDir, "index.html"))
				return
			}
			fs.ServeHTTP(w, r)
		})
	}

	StartScheduler(cfg)

	addr := fmt.Sprintf(":%d", cfg.Server.Port)
	log.Printf("starting server on %s", addr)
	srv := &http.Server{
		Addr:              addr,
		Handler:           gzipMiddleware(mux),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      10 * time.Minute,
		IdleTimeout:       10 * time.Minute,
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
