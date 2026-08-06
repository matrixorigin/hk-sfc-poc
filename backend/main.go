package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/go-sql-driver/mysql"
	"path/filepath"
	"time"
)

func main() {
	configPath := flag.String("config", "config.yaml", "path to config file")
	metricsPath := flag.String("metrics", "metrics.yaml", "path to metrics yaml (column explainability)")
	flag.Parse()

	cfg, err := LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	metrics, err := LoadMetrics(*metricsPath)
	if err != nil {
		log.Printf("warning: load metrics file %s: %v (metric explanations disabled)", *metricsPath, err)
		metrics = nil
	} else {
		log.Printf("loaded %d metric definition(s) from %s", len(metrics.all), *metricsPath)
	}

	client := NewExploreClient(cfg.Catalog.URL, cfg.Catalog.APIKey)

	// Feedback DB: connect to MatrixOne via workspace account
	moCfg := buildMOConfig(cfg)
	feedbackDB, err := NewFeedbackDB(moCfg)
	if err != nil {
		log.Fatalf("init feedback db: %v", err)
	}

	// Conversations DB 复用同一 MO 连接
	convDB, err := NewConversationsDB(feedbackDB.RawDB())
	if err != nil {
		log.Fatalf("init conversations db: %v", err)
	}

	authSvc, err := NewAuthService(feedbackDB.RawDB(), cfg.Auth)
	if err != nil {
		log.Fatalf("init auth service: %v", err)
	}

	// User table service (Excel upload → MatrixOne)
	userTableSvc, err := NewUserTableService(feedbackDB.RawDB(), cfg.Explore.DBName)
	if err != nil {
		log.Fatalf("init user table service: %v", err)
	}

	// Clarifier 依赖 ConversationsDB（读 pending_clarify + recent user questions）
	clarifier := NewClarifier(cfg.Catalog.URL, cfg.Catalog.APIKey, cfg.Catalog.WorkspaceID, cfg.Explore.LLMModel, convDB)

	mux := http.NewServeMux()

	authHandler := NewAuthHandler(authSvc)
	mux.HandleFunc("/api/auth/register", authHandler.RegisterDisabled)
	mux.HandleFunc("/api/auth/login", authHandler.Login)
	mux.HandleFunc("/api/auth/logout", authHandler.Logout)
	mux.HandleFunc("/api/auth/me", authHandler.Me)
	mux.Handle("/api/users", authHandler)
	mux.Handle("/api/users/", authHandler)

	// Dynamic /api/tables: system tables + user-uploaded tables
	systemTableList := []map[string]string{
		{"name": "ms_v_stk_hsi_daily", "label": "恒生指数日线 / HSI Daily", "source": "system"},
		{"name": "ms_t_stk_sis", "label": "个股行情 / Stock Trading", "source": "system"},
		{"name": "ms_v_stock_capital", "label": "市值数据 / Market Cap", "source": "system"},
		{"name": "ds_t_int_hsicl_dtl", "label": "行业分类 / Industry Classification", "source": "system"},
		{"name": "sehknews", "label": "新闻公告 / News", "source": "system"},
		{"name": "profit_loss", "label": "财务报表 / Financial Statements", "source": "system"},
		{"name": "ccass_holdings", "label": "CCASS持仓 / CCASS Holdings", "source": "system"},
	}
	mux.HandleFunc("/api/tables", func(w http.ResponseWriter, r *http.Request) {
		setCORSHeaders(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		tables := make([]map[string]string, len(systemTableList))
		copy(tables, systemTableList)
		userID := UserIDFromContext(r.Context())
		userTables, err := userTableSvc.ListUserTables(r.Context(), userID)
		if err == nil {
			for _, ut := range userTables {
				label := ut.TableName
				if ut.TableComment != "" {
					label = ut.TableName + " / " + ut.TableComment
				}
				tables = append(tables, map[string]string{
					"name":   ut.TableName,
					"label":  label,
					"source": "user",
				})
			}
		}
		writeJSON(w, http.StatusOK, tables)
	})

	knowledgeHandler := NewKnowledgeHandler(cfg)
	mux.Handle("/api/knowledge/", knowledgeHandler)
	mux.Handle("/api/knowledge", knowledgeHandler)

	// 会话消息流 handler
	messagesHandler := NewMessagesHandler(client, clarifier, convDB, cfg, metrics, userTableSvc)
	conversationsHandler := NewConversationsHandler(convDB, messagesHandler)
	mux.Handle("/api/conversations", conversationsHandler)
	mux.Handle("/api/conversations/", conversationsHandler)

	analyzer := NewFeedbackAnalyzer(cfg, feedbackDB, clarifier)
	feedbackHandler := NewFeedbackHandler(feedbackDB, analyzer)
	mux.HandleFunc("/api/feedback/", feedbackHandler.ServeHTTP)
	mux.HandleFunc("/api/feedback", feedbackHandler.ServeHTTP)

	paginateHandler := NewPaginateHandler(feedbackDB.RawDB())
	mux.HandleFunc("/api/query/paginate", paginateHandler.ServeHTTP)

	featureReproductionHandler := NewFeatureReproductionHandler(metrics)
	mux.HandleFunc("/api/feature-reproduction/package", featureReproductionHandler.ServeHTTP)
	mux.HandleFunc("/api/feature-reproduction/script", featureReproductionHandler.ServeHTTP)

	userTablesHandler := NewUserTablesHandler(userTableSvc)
	mux.Handle("/api/user-tables/", userTablesHandler)
	mux.Handle("/api/user-tables", userTablesHandler)

	if cfg.Server.StaticDir != "" {
		absDir, _ := filepath.Abs(cfg.Server.StaticDir)
		log.Printf("serving frontend from %s", absDir)
		fs := http.FileServer(http.Dir(absDir))
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			filePath := filepath.Join(absDir, r.URL.Path)
			if info, err := os.Stat(filePath); err != nil || info.IsDir() {
				w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
				http.ServeFile(w, r, filepath.Join(absDir, "index.html"))
				return
			}
			if strings.HasPrefix(r.URL.Path, "/assets/") {
				w.Header().Set("Cache-Control", "no-cache, must-revalidate")
			}
			fs.ServeHTTP(w, r)
		})
	}

	StartScheduler(cfg)

	addr := fmt.Sprintf(":%d", cfg.Server.Port)
	log.Printf("starting server on %s", addr)
	srv := &http.Server{
		Addr:              addr,
		Handler:           gzipMiddleware(authMiddleware(authSvc, mux)),
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      2 * time.Hour,
		IdleTimeout:       10 * time.Minute,
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

// buildMOConfig gets workspace account from Catalog API and builds a mysql.Config for MatrixOne.
func buildMOConfig(cfg *Config) *mysql.Config {
	moHost := os.Getenv("MO_HOST")
	if moHost == "" {
		moHost = "mo" // docker-compose service name
	}
	moPort := os.Getenv("MO_PORT")
	if moPort == "" {
		moPort = "6001"
	}

	acct := strings.TrimSpace(os.Getenv("MO_ACCOUNT_NAME"))
	if acct == "" {
		// Resolve account_name from Catalog unless local deployment provides it directly.
		url := fmt.Sprintf("%s/api/v1/workspaces/%s", cfg.Catalog.URL, cfg.Catalog.WorkspaceID)
		req, _ := http.NewRequest("GET", url, nil)
		req.Header.Set("X-API-Key", cfg.Catalog.APIKey)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			log.Fatalf("get workspace account: %v", err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)

		var wsResp struct {
			Data struct {
				AccountName string `json:"account_name"`
			} `json:"data"`
		}
		if err := json.Unmarshal(body, &wsResp); err != nil || wsResp.Data.AccountName == "" {
			log.Fatalf("parse workspace account: %v, body: %s", err, body)
		}
		acct = wsResp.Data.AccountName
	}
	user := acct + ":moi_core_system"
	pass := cfg.Catalog.APIKey
	dbName := cfg.Explore.DBName

	mysqlCfg := mysql.NewConfig()
	mysqlCfg.User = user
	mysqlCfg.Passwd = pass
	mysqlCfg.Net = "tcp"
	mysqlCfg.Addr = fmt.Sprintf("%s:%s", moHost, moPort)
	mysqlCfg.DBName = dbName
	mysqlCfg.AllowNativePasswords = true
	mysqlCfg.AllowAllFiles = true
	log.Printf("feedback db: connecting to MO as %s@%s:%s/%s", user, moHost, moPort, dbName)
	return mysqlCfg
}
