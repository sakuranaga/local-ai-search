package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

func RunCLI(args []string, store *Store) {
	if len(args) < 1 {
		printCLIHelp()
		os.Exit(1)
	}

	switch args[0] {
	case "key":
		if len(args) < 2 {
			fmt.Println("Usage: share-server key <create|list|revoke>")
			os.Exit(1)
		}
		switch args[1] {
		case "create":
			name := "default"
			note := ""
			for i := 2; i < len(args); i++ {
				if args[i] == "--name" && i+1 < len(args) {
					name = args[i+1]
					i++
				}
				if args[i] == "--note" && i+1 < len(args) {
					note = args[i+1]
					i++
				}
			}
			key := GenerateAPIKey()
			id := uuid.New().String()
			hash := hashKey(key)
			if err := store.CreateAPIKey(id, hash, name, note); err != nil {
				fmt.Printf("Error: %v\n", err)
				os.Exit(1)
			}
			fmt.Printf("Created API key:\n")
			fmt.Printf("  ID:   %s\n", id)
			fmt.Printf("  Key:  %s\n", key)
			fmt.Printf("  Name: %s\n", name)
			fmt.Println("\nSave this key — it cannot be retrieved later.")

		case "list":
			keys, err := store.ListAPIKeys()
			if err != nil {
				fmt.Printf("Error: %v\n", err)
				os.Exit(1)
			}
			if len(keys) == 0 {
				fmt.Println("No API keys found.")
				return
			}
			fmt.Printf("%-36s  %-20s  %-20s  %s\n", "ID", "Name", "Created", "Active")
			fmt.Println("----  ----  ----  ----")
			for _, k := range keys {
				active := "✓"
				if !k.IsActive {
					active = "✗"
				}
				fmt.Printf("%-36s  %-20s  %-20s  %s\n",
					k.ID, k.Name, k.CreatedAt.Format("2006-01-02 15:04"), active)
			}

		case "revoke":
			if len(args) < 3 {
				fmt.Println("Usage: share-server key revoke <id>")
				os.Exit(1)
			}
			if err := store.RevokeAPIKey(args[2]); err != nil {
				fmt.Printf("Error: %v\n", err)
				os.Exit(1)
			}
			fmt.Println("API key revoked.")

		default:
			fmt.Printf("Unknown key command: %s\n", args[1])
			os.Exit(1)
		}

	case "links":
		if len(args) >= 3 && args[1] == "delete" {
			link, err := store.GetShareLinkByToken(args[2])
			if err != nil {
				fmt.Printf("Link not found: %s\n", args[2])
				os.Exit(1)
			}
			cfg := LoadConfig()
			filePath := filepath.Join(cfg.DataDir, "files", link.FilePath)
			os.Remove(filePath)
			store.DeleteShareLink(args[2])
			fmt.Printf("Deleted: %s (%s)\n", link.Filename, args[2])
			return
		}
		links, err := store.ListShareLinks()
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			os.Exit(1)
		}
		if len(links) == 0 {
			fmt.Println("No share links.")
			return
		}
		fmt.Printf("%-12s  %-30s  %-12s  %-8s  %s\n", "Token", "Filename", "Expires", "Active", "Password")
		fmt.Println("----  ----  ----  ----  ----")
		for _, l := range links {
			active := "✓"
			if !l.IsActive {
				active = "✗"
			}
			pw := "No"
			if l.PasswordHash != "" {
				pw = "Yes"
			}
			tokenShort := l.Token
			if len(tokenShort) > 12 {
				tokenShort = tokenShort[:12] + "..."
			}
			nameShort := l.Filename
			if len(nameShort) > 30 {
				nameShort = nameShort[:27] + "..."
			}
			fmt.Printf("%-15s  %-30s  %-12s  %-8s  %s\n",
				tokenShort, nameShort, l.ExpiresAt.Format("2006-01-02"), active, pw)
		}

	case "status":
		active, expired, keys, _ := store.Stats()
		fmt.Printf("Links:    %d active, %d expired\n", active, expired)
		fmt.Printf("API Keys: %d active\n", keys)

	case "cleanup":
		cfg := LoadConfig()
		cleanup(store, cfg.DataDir)
		fmt.Println("Cleanup complete.")

	default:
		printCLIHelp()
		os.Exit(1)
	}
}

func printCLIHelp() {
	fmt.Println(`LAS Share Server

Usage:
  share-server                     Start HTTP server
  share-server key create          Create a new API key
  share-server key list            List API keys
  share-server key revoke <id>     Revoke an API key
  share-server links               List share links
  share-server links delete <token> Delete a share link
  share-server status              Show server status
  share-server cleanup             Run cleanup now`)
}
