package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
)

func main() {
	configPath := flag.String("config", "config.yaml", "path to config file")
	flag.Parse()

	cfg, err := LoadConfig(*configPath)
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	client := NewExploreClient(cfg.Catalog.URL, cfg.Catalog.APIKey)
	chatHandler := &ChatHandler{client: client, cfg: cfg}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/chat", chatHandler.ServeHTTP)

	addr := fmt.Sprintf(":%d", cfg.Server.Port)
	log.Printf("starting server on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
