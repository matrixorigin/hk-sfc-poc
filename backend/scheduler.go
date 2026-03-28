package main

import (
	"fmt"
	"log"
	"os/exec"
	"strings"
	"time"
)

// StartScheduler 启动后台定时任务。
func StartScheduler(cfg *Config) {
	if cfg.Jobs.CCASS.Enabled {
		go runCCASSScheduler(cfg.Jobs.CCASS)
	}
}

func runCCASSScheduler(cfg CCASSSyncConfig) {
	schedule := cfg.Schedule
	if schedule == "" {
		schedule = "20:00"
	}
	script := cfg.Script
	if script == "" {
		script = "scripts/cron_ccass.sh"
	}

	parts := strings.Split(schedule, ":")
	if len(parts) != 2 {
		log.Printf("scheduler: invalid ccass schedule %q, expected HH:MM", schedule)
		return
	}

	log.Printf("scheduler: CCASS sync enabled, schedule=%s top=%d script=%s", schedule, cfg.Top, script)

	for {
		now := time.Now()
		next := nextRunTime(now, schedule)
		wait := next.Sub(now)
		log.Printf("scheduler: next CCASS run at %s (in %s)", next.Format("2006-01-02 15:04"), wait.Round(time.Minute))

		time.Sleep(wait)

		// 跳过周末
		dow := time.Now().Weekday()
		if dow == time.Saturday || dow == time.Sunday {
			log.Printf("scheduler: skipping CCASS (weekend)")
			continue
		}

		log.Printf("scheduler: running CCASS sync...")
		args := []string{script}
		cmd := exec.Command("bash", args...)
		if cfg.Top > 0 {
			cmd.Env = append(cmd.Environ(), fmt.Sprintf("CCASS_TOP=%d", cfg.Top))
		}
		output, err := cmd.CombinedOutput()
		if err != nil {
			log.Printf("scheduler: CCASS sync failed: %v\n%s", err, string(output))
		} else {
			log.Printf("scheduler: CCASS sync completed\n%s", string(output))
		}
	}
}

// nextRunTime 计算下一个执行时间点。
func nextRunTime(now time.Time, schedule string) time.Time {
	parts := strings.Split(schedule, ":")
	var hour, min int
	fmt.Sscanf(parts[0], "%d", &hour)
	fmt.Sscanf(parts[1], "%d", &min)

	next := time.Date(now.Year(), now.Month(), now.Day(), hour, min, 0, 0, now.Location())
	if !next.After(now) {
		next = next.Add(24 * time.Hour)
	}
	return next
}
