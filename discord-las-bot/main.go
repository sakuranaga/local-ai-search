package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/joho/godotenv"
)

type IngestRequest struct {
	Title      string   `json:"title"`
	Content    string   `json:"content"`
	Source     string   `json:"source"`
	ExternalID string   `json:"external_id"`
	Mode       string   `json:"mode"`
	Folder     string   `json:"folder"`
	Tags       []string `json:"tags,omitempty"`
}

var (
	// channelID -> document title (manual config or auto-discovered)
	channels   map[string]string
	channelsMu sync.RWMutex
	autoMode   bool
)

func main() {
	_ = godotenv.Load()

	token := os.Getenv("DISCORD_TOKEN")
	lasURL := os.Getenv("LAS_API_URL")
	lasKey := os.Getenv("LAS_API_KEY")
	lasFolder := os.Getenv("LAS_FOLDER")
	lasSource := os.Getenv("LAS_SOURCE")

	// Parse tags (comma-separated, empty = no tags)
	var lasTags []string
	if tagStr := strings.TrimSpace(os.Getenv("LAS_TAGS")); tagStr != "" {
		for _, t := range strings.Split(tagStr, ",") {
			if t = strings.TrimSpace(t); t != "" {
				lasTags = append(lasTags, t)
			}
		}
	}

	if token == "" || lasURL == "" || lasKey == "" {
		log.Fatal("Missing required environment variables")
	}

	// Load manual channel mappings: CHANNEL_<id>=<doc title>
	channels = make(map[string]string)
	for _, env := range os.Environ() {
		if strings.HasPrefix(env, "CHANNEL_") {
			parts := strings.SplitN(env, "=", 2)
			key := strings.TrimPrefix(parts[0], "CHANNEL_")
			if len(parts) == 2 && key != "" && parts[1] != "" {
				channels[key] = parts[1]
			}
		}
	}

	if len(channels) > 0 {
		autoMode = false
		for id, title := range channels {
			log.Printf("Watching channel %s -> %s (manual)", id, title)
		}
	} else {
		autoMode = true
		log.Println("Auto mode: watching all accessible text channels")
	}

	dg, err := discordgo.New("Bot " + token)
	if err != nil {
		log.Fatalf("Error creating Discord session: %v", err)
	}

	dg.Identify.Intents = discordgo.IntentsGuildMessages | discordgo.IntentMessageContent | discordgo.IntentsGuilds

	client := &http.Client{Timeout: 30 * time.Second}

	// Auto-discover channels when guilds are available
	dg.AddHandler(func(s *discordgo.Session, r *discordgo.Ready) {
		if !autoMode {
			return
		}
		discoverChannels(s)
	})

	// Pick up new channels created after bot start
	dg.AddHandler(func(s *discordgo.Session, c *discordgo.ChannelCreate) {
		if !autoMode {
			return
		}
		if c.Type == discordgo.ChannelTypeGuildText || c.Type == discordgo.ChannelTypeGuildVoice {
			title := "Discord-"
			if c.ParentID != "" {
				if cat, err := s.Channel(c.ParentID); err == nil {
					title += cat.Name + "-"
				}
			}
			title += c.Name
			channelsMu.Lock()
			channels[c.ID] = title
			channelsMu.Unlock()
			log.Printf("New channel discovered: %s -> %s", c.ID, title)
		}
	})

	// Handle messages
	dg.AddHandler(func(s *discordgo.Session, m *discordgo.MessageCreate) {
		if m.Author.Bot {
			return
		}

		channelsMu.RLock()
		docTitle, ok := channels[m.ChannelID]
		channelsMu.RUnlock()

		if !ok {
			return
		}

		timestamp := m.Timestamp
		content := fmt.Sprintf("\n---\n**%s** (%s)\n%s",
			m.Author.Username, timestamp.Format("2006-01-02 15:04:05"), m.Content)

		req := IngestRequest{
			Title:      docTitle,
			Content:    content,
			Source:     lasSource,
			ExternalID: "channel-" + m.ChannelID,
			Mode:       "append",
			Folder:     lasFolder,
			Tags:       lasTags,
		}

		body, _ := json.Marshal(req)
		httpReq, err := http.NewRequest("POST", lasURL, bytes.NewReader(body))
		if err != nil {
			log.Printf("Error creating request: %v", err)
			return
		}
		httpReq.Header.Set("Content-Type", "application/json")
		httpReq.Header.Set("Authorization", "Bearer "+lasKey)

		resp, err := client.Do(httpReq)
		if err != nil {
			log.Printf("Error sending to LAS: %v", err)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode >= 300 {
			log.Printf("[%s] LAS returned %d for message from %s", docTitle, resp.StatusCode, m.Author.Username)
		} else {
			log.Printf("[%s] Saved message from %s", docTitle, m.Author.Username)
		}
	})

	if err := dg.Open(); err != nil {
		log.Fatalf("Error opening connection: %v", err)
	}
	defer dg.Close()

	log.Printf("Bot is running")

	sc := make(chan os.Signal, 1)
	signal.Notify(sc, syscall.SIGINT, syscall.SIGTERM)
	<-sc
	log.Println("Shutting down...")
}

func discoverChannels(s *discordgo.Session) {
	channelsMu.Lock()
	defer channelsMu.Unlock()

	for _, guild := range s.State.Guilds {
		guildChannels, err := s.GuildChannels(guild.ID)
		if err != nil {
			log.Printf("Error fetching channels for guild %s: %v", guild.Name, err)
			continue
		}
		// Build category ID -> name map
		categories := make(map[string]string)
		for _, ch := range guildChannels {
			if ch.Type == discordgo.ChannelTypeGuildCategory {
				categories[ch.ID] = ch.Name
			}
		}
		for _, ch := range guildChannels {
			if ch.Type == discordgo.ChannelTypeGuildText || ch.Type == discordgo.ChannelTypeGuildVoice {
				title := "Discord-"
				if ch.ParentID != "" {
					if catName, ok := categories[ch.ParentID]; ok {
						title += catName + "-"
					}
				}
				title += ch.Name
				channels[ch.ID] = title
				log.Printf("Discovered: %s -> %s (%s)", ch.ID, title, guild.Name)
			}
		}
	}
}
