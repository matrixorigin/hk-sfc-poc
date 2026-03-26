package main

import (
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
	chatHandler := &ChatHandler{client: client, clarify: clarifier, cfg: cfg}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/chat", chatHandler.ServeHTTP)

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
