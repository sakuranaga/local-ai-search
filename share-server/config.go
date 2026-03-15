package main

import (
	"os"
)

type Config struct {
	Port              string
	DataDir           string
	BaseURL           string
	JWTSecret         string
	MaxFileSizeMB     int
	CleanupIntervalH  int
}

func LoadConfig() *Config {
	return &Config{
		Port:             getEnv("SHARE_PORT", "8080"),
		DataDir:          getEnv("SHARE_DATA_DIR", "./data"),
		BaseURL:          getEnv("SHARE_BASE_URL", "http://localhost:8080"),
		JWTSecret:        getEnv("SHARE_JWT_SECRET", "changeme"),
		MaxFileSizeMB:    getEnvInt("SHARE_MAX_FILE_SIZE_MB", 500),
		CleanupIntervalH: getEnvInt("SHARE_CLEANUP_INTERVAL_HOURS", 1),
	}
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getEnvInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n := 0
	for _, c := range v {
		if c >= '0' && c <= '9' {
			n = n*10 + int(c-'0')
		}
	}
	if n == 0 {
		return fallback
	}
	return n
}
