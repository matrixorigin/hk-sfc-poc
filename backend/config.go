package main

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Server  ServerConfig  `yaml:"server"`
	Catalog CatalogConfig `yaml:"catalog"`
	Explore ExploreConfig `yaml:"explore"`
}

type ServerConfig struct {
	Port      int    `yaml:"port"`
	StaticDir string `yaml:"static_dir"`
}

type CatalogConfig struct {
	URL         string `yaml:"url"`
	APIKey      string `yaml:"api_key"`
	WorkspaceID string `yaml:"workspace_id"`
}

type ExploreConfig struct {
	DBName           string  `yaml:"db_name"`
	Tables           []string `yaml:"tables"`
	PlanningMode     string  `yaml:"planning_mode"`
	Verbose          string  `yaml:"verbose"`
	LLMModel         string  `yaml:"llm_model"`
	KnowledgeBaseID  int64   `yaml:"knowledge_base_id"`
}

func LoadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config file: %w", err)
	}

	expanded := os.ExpandEnv(string(data))

	var cfg Config
	if err := yaml.Unmarshal([]byte(expanded), &cfg); err != nil {
		return nil, fmt.Errorf("parse config yaml: %w", err)
	}

	return &cfg, nil
}
