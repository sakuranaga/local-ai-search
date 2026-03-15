package main

import (
	"crypto/sha256"
	"database/sql"
	"fmt"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

type Store struct {
	db *sql.DB
}

type ShareLink struct {
	ID           string
	Token        string
	Filename     string
	FileType     string
	FileSize     int64
	FilePath     string
	PasswordHash string // "salt$hash" or ""
	ExpiresAt    time.Time
	CreatedBy    string
	CreatedAt    time.Time
	IsActive     bool
	APIKeyID     string
}

type APIKey struct {
	ID        string
	KeyHash   string
	Name      string
	Note      string
	CreatedAt time.Time
	IsActive  bool
}

type AccessLogEntry struct {
	ID          int64
	ShareLinkID string
	Action      string
	IPAddress   string
	UserAgent   string
	AccessedAt  time.Time
}

func NewStore(dbPath string) (*Store, error) {
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, err
	}

	if err := db.Ping(); err != nil {
		return nil, err
	}

	if err := migrate(db); err != nil {
		return nil, err
	}

	return &Store{db: db}, nil
}

func migrate(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS api_keys (
			id TEXT PRIMARY KEY,
			key_hash TEXT UNIQUE NOT NULL,
			name TEXT NOT NULL,
			note TEXT DEFAULT '',
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			is_active BOOLEAN DEFAULT 1
		);

		CREATE TABLE IF NOT EXISTS share_links (
			id TEXT PRIMARY KEY,
			token TEXT UNIQUE NOT NULL,
			filename TEXT NOT NULL,
			file_type TEXT NOT NULL,
			file_size INTEGER NOT NULL,
			file_path TEXT NOT NULL,
			password_hash TEXT DEFAULT '',
			expires_at DATETIME NOT NULL,
			created_by TEXT NOT NULL,
			created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
			is_active BOOLEAN DEFAULT 1,
			api_key_id TEXT REFERENCES api_keys(id)
		);

		CREATE TABLE IF NOT EXISTS access_log (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			share_link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
			action TEXT NOT NULL,
			ip_address TEXT DEFAULT '',
			user_agent TEXT DEFAULT '',
			accessed_at DATETIME DEFAULT CURRENT_TIMESTAMP
		);
	`)
	return err
}

func (s *Store) Close() {
	s.db.Close()
}

// --- API Keys ---

func hashKey(key string) string {
	h := sha256.Sum256([]byte(key))
	return fmt.Sprintf("%x", h)
}

func (s *Store) CreateAPIKey(id, keyHash, name, note string) error {
	_, err := s.db.Exec(
		"INSERT INTO api_keys (id, key_hash, name, note) VALUES (?, ?, ?, ?)",
		id, keyHash, name, note,
	)
	return err
}

func (s *Store) ValidateAPIKey(key string) (*APIKey, error) {
	h := hashKey(key)
	var k APIKey
	err := s.db.QueryRow(
		"SELECT id, key_hash, name, note, created_at, is_active FROM api_keys WHERE key_hash = ? AND is_active = 1",
		h,
	).Scan(&k.ID, &k.KeyHash, &k.Name, &k.Note, &k.CreatedAt, &k.IsActive)
	if err != nil {
		return nil, err
	}
	return &k, nil
}

func (s *Store) ListAPIKeys() ([]APIKey, error) {
	rows, err := s.db.Query("SELECT id, name, note, created_at, is_active FROM api_keys ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var keys []APIKey
	for rows.Next() {
		var k APIKey
		rows.Scan(&k.ID, &k.Name, &k.Note, &k.CreatedAt, &k.IsActive)
		keys = append(keys, k)
	}
	return keys, nil
}

func (s *Store) RevokeAPIKey(id string) error {
	_, err := s.db.Exec("UPDATE api_keys SET is_active = 0 WHERE id = ?", id)
	return err
}

// --- Share Links ---

func (s *Store) CreateShareLink(link *ShareLink) error {
	_, err := s.db.Exec(
		`INSERT INTO share_links (id, token, filename, file_type, file_size, file_path, password_hash, expires_at, created_by, api_key_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		link.ID, link.Token, link.Filename, link.FileType, link.FileSize, link.FilePath,
		link.PasswordHash, link.ExpiresAt.UTC().Format(time.RFC3339), link.CreatedBy, link.APIKeyID,
	)
	return err
}

func (s *Store) GetShareLinkByToken(token string) (*ShareLink, error) {
	var link ShareLink
	var expiresStr string
	var createdStr string
	var pwHash sql.NullString
	err := s.db.QueryRow(
		`SELECT id, token, filename, file_type, file_size, file_path, password_hash, expires_at, created_by, created_at, is_active
		 FROM share_links WHERE token = ?`, token,
	).Scan(&link.ID, &link.Token, &link.Filename, &link.FileType, &link.FileSize, &link.FilePath,
		&pwHash, &expiresStr, &link.CreatedBy, &createdStr, &link.IsActive)
	if err != nil {
		return nil, err
	}
	link.PasswordHash = pwHash.String
	link.ExpiresAt, _ = time.Parse(time.RFC3339, expiresStr)
	link.CreatedAt, _ = time.Parse(time.RFC3339, createdStr)
	return &link, nil
}

func (s *Store) DeleteShareLink(token string) error {
	// Get file path before deleting
	var filePath string
	s.db.QueryRow("SELECT file_path FROM share_links WHERE token = ?", token).Scan(&filePath)
	_, err := s.db.Exec("DELETE FROM share_links WHERE token = ?", token)
	return err
}

func (s *Store) DeactivateShareLink(token string) error {
	_, err := s.db.Exec("UPDATE share_links SET is_active = 0 WHERE token = ?", token)
	return err
}

func (s *Store) ListShareLinks() ([]ShareLink, error) {
	rows, err := s.db.Query(
		`SELECT id, token, filename, file_type, file_size, password_hash, expires_at, created_by, created_at, is_active
		 FROM share_links ORDER BY created_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var links []ShareLink
	for rows.Next() {
		var link ShareLink
		var expiresStr, createdStr string
		var pwHash sql.NullString
		rows.Scan(&link.ID, &link.Token, &link.Filename, &link.FileType, &link.FileSize,
			&pwHash, &expiresStr, &link.CreatedBy, &createdStr, &link.IsActive)
		link.PasswordHash = pwHash.String
		link.ExpiresAt, _ = time.Parse(time.RFC3339, expiresStr)
		link.CreatedAt, _ = time.Parse(time.RFC3339, createdStr)
		links = append(links, link)
	}
	return links, nil
}

func (s *Store) LogAccess(linkID, action, ip, ua string) {
	s.db.Exec(
		"INSERT INTO access_log (share_link_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)",
		linkID, action, ip, ua,
	)
}

// --- Cleanup ---

func (s *Store) GetExpiredLinks() ([]ShareLink, error) {
	rows, err := s.db.Query(
		`SELECT id, file_path FROM share_links
		 WHERE expires_at < datetime('now') OR is_active = 0`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var links []ShareLink
	for rows.Next() {
		var link ShareLink
		rows.Scan(&link.ID, &link.FilePath)
		links = append(links, link)
	}
	return links, nil
}

func (s *Store) PurgeLink(id string) error {
	s.db.Exec("DELETE FROM access_log WHERE share_link_id = ?", id)
	_, err := s.db.Exec("DELETE FROM share_links WHERE id = ?", id)
	return err
}

// --- Stats ---

func (s *Store) Stats() (activeLinks, expiredLinks, activeKeys int, err error) {
	s.db.QueryRow("SELECT COUNT(*) FROM share_links WHERE is_active = 1 AND expires_at > datetime('now')").Scan(&activeLinks)
	s.db.QueryRow("SELECT COUNT(*) FROM share_links WHERE expires_at <= datetime('now') OR is_active = 0").Scan(&expiredLinks)
	s.db.QueryRow("SELECT COUNT(*) FROM api_keys WHERE is_active = 1").Scan(&activeKeys)
	return
}
