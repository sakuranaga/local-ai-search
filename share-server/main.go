package main

import (
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

func main() {
	config := LoadConfig()

	// Ensure data directories exist
	os.MkdirAll(filepath.Join(config.DataDir, "files"), 0755)

	// Initialize store
	dbPath := filepath.Join(config.DataDir, "share.db")
	store, err := NewStore(dbPath)
	if err != nil {
		log.Fatalf("Failed to initialize database: %v", err)
	}
	defer store.Close()

	// CLI mode
	if len(os.Args) > 1 {
		RunCLI(os.Args[1:], store)
		return
	}

	// HTTP server mode
	handler := NewHandler(store, config)

	mux := http.NewServeMux()

	// Internal API (LAS → Share Server)
	mux.HandleFunc("POST /api/internal/upload", handler.HandleInternalUpload)
	mux.HandleFunc("DELETE /api/internal/{token}", handler.HandleInternalDelete)
	mux.HandleFunc("GET /api/internal/status", handler.HandleInternalStatus)

	// Public pages
	mux.HandleFunc("GET /s/{token}", handler.HandleSharePage)
	mux.HandleFunc("POST /s/{token}/verify", handler.HandleVerify)
	mux.HandleFunc("GET /s/{token}/download", handler.HandleDownload)

	// Start cleanup goroutine
	StartCleanupLoop(store, config.DataDir, config.CleanupIntervalH)

	addr := fmt.Sprintf(":%s", config.Port)
	log.Printf("LAS Share Server starting on %s", addr)
	log.Printf("Base URL: %s", config.BaseURL)
	log.Printf("Data dir: %s", config.DataDir)
	log.Fatal(http.ListenAndServe(addr, mux))
}
