package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
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

	addr := fmt.Sprintf(":%d", cfg.Server.Port)
	log.Printf("starting server on %s", addr)
	srv := &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		WriteTimeout:      10 * time.Minute,
		IdleTimeout:       10 * time.Minute,
	}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
