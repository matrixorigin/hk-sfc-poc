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
	Jobs    JobsConfig    `yaml:"jobs"`
}

type JobsConfig struct {
	CCASS CCASSSyncConfig `yaml:"ccass"`
}

type CCASSSyncConfig struct {
	Enabled  bool   `yaml:"enabled"`           // 是否启用定时爬取
	Schedule string `yaml:"schedule"`           // 每天执行时间，如 "20:00"
	Top      int    `yaml:"top"`                // 爬取前 N 只股票，0 = 全量
	Script   string `yaml:"script"`             // 脚本路径，默认 scripts/cron_ccass.sh
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

	if cfg.Server.Port == 0 {
		cfg.Server.Port = 8083
	}
	if cfg.Catalog.URL == "" {
		cfg.Catalog.URL = "http://localhost:8084"
	}

	return &cfg, nil
}
