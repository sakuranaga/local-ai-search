package main

import (
	"log"
	"os"
	"path/filepath"
	"time"
)

func StartCleanupLoop(store *Store, dataDir string, intervalHours int) {
	interval := time.Duration(intervalHours) * time.Hour
	go func() {
		for {
			time.Sleep(interval)
			cleanup(store, dataDir)
		}
	}()
	log.Printf("Cleanup loop started (every %d hours)", intervalHours)
}

func cleanup(store *Store, dataDir string) {
	links, err := store.GetExpiredLinks()
	if err != nil {
		log.Printf("Cleanup: failed to get expired links: %v", err)
		return
	}

	if len(links) == 0 {
		return
	}

	for _, link := range links {
		filePath := filepath.Join(dataDir, "files", link.FilePath)
		if err := os.Remove(filePath); err != nil && !os.IsNotExist(err) {
			log.Printf("Cleanup: failed to remove file %s: %v", filePath, err)
		}
		if err := store.PurgeLink(link.ID); err != nil {
			log.Printf("Cleanup: failed to purge link %s: %v", link.ID, err)
		}
	}

	log.Printf("Cleanup: removed %d expired links", len(links))
}
