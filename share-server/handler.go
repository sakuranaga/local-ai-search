package main

import (
	"encoding/json"
	"fmt"
	"html/template"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
)

type Handler struct {
	store     *Store
	config    *Config
	templates *template.Template
}

func NewHandler(store *Store, config *Config) *Handler {
	funcMap := template.FuncMap{
		"formatSize": formatSize,
		"formatDate": func(t time.Time) string {
			return t.Format("2006/01/02")
		},
	}
	tmpl := template.Must(template.New("").Funcs(funcMap).ParseGlob("templates/*.html"))
	return &Handler{store: store, config: config, templates: tmpl}
}

func formatSize(size int64) string {
	if size < 1024 {
		return fmt.Sprintf("%d B", size)
	}
	if size < 1024*1024 {
		return fmt.Sprintf("%.1f KB", float64(size)/1024)
	}
	if size < 1024*1024*1024 {
		return fmt.Sprintf("%.1f MB", float64(size)/(1024*1024))
	}
	return fmt.Sprintf("%.1f GB", float64(size)/(1024*1024*1024))
}

// --- Internal API (LAS → Share Server) ---

func (h *Handler) requireAPIKey(r *http.Request) bool {
	key := r.Header.Get("X-Api-Key")
	if key == "" {
		return false
	}
	_, err := h.store.ValidateAPIKey(key)
	return err == nil
}

func (h *Handler) getAPIKeyID(r *http.Request) string {
	key := r.Header.Get("X-Api-Key")
	if key == "" {
		return ""
	}
	k, err := h.store.ValidateAPIKey(key)
	if err != nil {
		return ""
	}
	return k.ID
}

func (h *Handler) HandleInternalUpload(w http.ResponseWriter, r *http.Request) {
	if !h.requireAPIKey(r) {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	// Parse multipart (max file size)
	maxSize := int64(h.config.MaxFileSizeMB) * 1024 * 1024
	r.ParseMultipartForm(maxSize)

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, `{"error":"file required"}`, http.StatusBadRequest)
		return
	}
	defer file.Close()

	token := r.FormValue("token")
	filename := r.FormValue("filename")
	fileType := r.FormValue("file_type")
	passwordHash := r.FormValue("password_hash")
	expiresAtStr := r.FormValue("expires_at")
	createdBy := r.FormValue("created_by")

	if token == "" || filename == "" {
		http.Error(w, `{"error":"token and filename required"}`, http.StatusBadRequest)
		return
	}

	// Parse expiry
	expiresAt, err := time.Parse(time.RFC3339, expiresAtStr)
	if err != nil {
		// Default to 7 days
		expiresAt = time.Now().Add(7 * 24 * time.Hour)
	}

	// Max 30 days
	maxExpiry := time.Now().Add(30 * 24 * time.Hour)
	if expiresAt.After(maxExpiry) {
		expiresAt = maxExpiry
	}

	// Save file
	filesDir := filepath.Join(h.config.DataDir, "files")
	os.MkdirAll(filesDir, 0755)
	fileID := uuid.New().String()
	ext := filepath.Ext(filename)
	storedName := fileID + ext
	destPath := filepath.Join(filesDir, storedName)

	dest, err := os.Create(destPath)
	if err != nil {
		log.Printf("Failed to create file: %v", err)
		http.Error(w, `{"error":"failed to save file"}`, http.StatusInternalServerError)
		return
	}
	defer dest.Close()
	written, err := io.Copy(dest, file)
	if err != nil {
		log.Printf("Failed to write file: %v", err)
		http.Error(w, `{"error":"failed to write file"}`, http.StatusInternalServerError)
		return
	}

	linkID := uuid.New().String()
	link := &ShareLink{
		ID:           linkID,
		Token:        token,
		Filename:     filename,
		FileType:     fileType,
		FileSize:     written,
		FilePath:     storedName,
		PasswordHash: passwordHash,
		ExpiresAt:    expiresAt,
		CreatedBy:    createdBy,
		APIKeyID:     h.getAPIKeyID(r),
	}

	if err := h.store.CreateShareLink(link); err != nil {
		os.Remove(destPath)
		log.Printf("Failed to create share link: %v", err)
		http.Error(w, `{"error":"failed to create link"}`, http.StatusInternalServerError)
		return
	}

	url := fmt.Sprintf("%s/s/%s", strings.TrimRight(h.config.BaseURL, "/"), token)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{
		"id":  linkID,
		"url": url,
	})

	log.Printf("Upload: %s (%s, %s) → %s", filename, fileType, formatSize(header.Size), token)
}

func (h *Handler) HandleInternalDelete(w http.ResponseWriter, r *http.Request) {
	if !h.requireAPIKey(r) {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	token := r.PathValue("token")
	link, err := h.store.GetShareLinkByToken(token)
	if err != nil {
		http.Error(w, `{"error":"not found"}`, http.StatusNotFound)
		return
	}

	// Delete file
	filePath := filepath.Join(h.config.DataDir, "files", link.FilePath)
	os.Remove(filePath)

	h.store.DeleteShareLink(token)
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) HandleInternalStatus(w http.ResponseWriter, r *http.Request) {
	if !h.requireAPIKey(r) {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	active, expired, keys, _ := h.store.Stats()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"active_links":  active,
		"expired_links": expired,
		"api_keys":      keys,
		"ok":            true,
	})
}

// --- Public endpoints ---

func (h *Handler) HandleSharePage(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	link, err := h.store.GetShareLinkByToken(token)
	if err != nil {
		h.renderError(w, "共有リンクが見つかりません", http.StatusNotFound)
		return
	}

	if !link.IsActive {
		h.renderError(w, "この共有リンクは無効です", http.StatusGone)
		return
	}

	if link.ExpiresAt.Before(time.Now()) {
		h.renderError(w, "この共有リンクの有効期限が切れています", http.StatusGone)
		return
	}

	// Password required?
	if link.PasswordHash != "" {
		// Check cookie
		cookieToken := GetShareCookie(r)
		if cookieToken == "" {
			h.renderPassword(w, token, "")
			return
		}
		verifiedID, ok := VerifyShareToken(cookieToken, h.config.JWTSecret)
		if !ok || verifiedID != link.ID {
			h.renderPassword(w, token, "")
			return
		}
	}

	h.renderDownload(w, link)
}

func (h *Handler) HandleVerify(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	link, err := h.store.GetShareLinkByToken(token)
	if err != nil {
		h.renderError(w, "共有リンクが見つかりません", http.StatusNotFound)
		return
	}

	r.ParseForm()
	password := r.FormValue("password")

	if !VerifyPassword(password, link.PasswordHash) {
		h.store.LogAccess(link.ID, "password_fail", getIP(r), r.UserAgent())
		h.renderPassword(w, token, "パスワードが正しくありません")
		return
	}

	// Create temporary token and set cookie
	jwtToken, err := CreateShareToken(link.ID, h.config.JWTSecret)
	if err != nil {
		h.renderError(w, "エラーが発生しました", http.StatusInternalServerError)
		return
	}
	SetShareCookie(w, jwtToken)
	http.Redirect(w, r, "/s/"+token, http.StatusSeeOther)
}

func (h *Handler) HandleDownload(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	link, err := h.store.GetShareLinkByToken(token)
	if err != nil {
		http.Error(w, "Not found", http.StatusNotFound)
		return
	}

	if !link.IsActive || link.ExpiresAt.Before(time.Now()) {
		http.Error(w, "Expired", http.StatusGone)
		return
	}

	// Check password
	if link.PasswordHash != "" {
		cookieToken := GetShareCookie(r)
		verifiedID, ok := VerifyShareToken(cookieToken, h.config.JWTSecret)
		if !ok || verifiedID != link.ID {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
	}

	filePath := filepath.Join(h.config.DataDir, "files", link.FilePath)
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		http.Error(w, "File not found", http.StatusNotFound)
		return
	}

	h.store.LogAccess(link.ID, "download", getIP(r), r.UserAgent())

	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, link.Filename))
	http.ServeFile(w, r, filePath)
}

// --- Template rendering ---

func (h *Handler) renderDownload(w http.ResponseWriter, link *ShareLink) {
	h.templates.ExecuteTemplate(w, "download.html", map[string]interface{}{
		"Token":     link.Token,
		"Filename":  link.Filename,
		"FileType":  strings.ToUpper(link.FileType),
		"FileSize":  formatSize(link.FileSize),
		"CreatedBy": link.CreatedBy,
		"ExpiresAt": link.ExpiresAt.Format("2006/01/02"),
	})
}

func (h *Handler) renderPassword(w http.ResponseWriter, token, errMsg string) {
	h.templates.ExecuteTemplate(w, "password.html", map[string]interface{}{
		"Token": token,
		"Error": errMsg,
	})
}

func (h *Handler) renderError(w http.ResponseWriter, message string, code int) {
	w.WriteHeader(code)
	h.templates.ExecuteTemplate(w, "error.html", map[string]interface{}{
		"Message": message,
	})
}

func getIP(r *http.Request) string {
	if ip := r.Header.Get("X-Real-IP"); ip != "" {
		return ip
	}
	if ip := r.Header.Get("X-Forwarded-For"); ip != "" {
		return strings.Split(ip, ",")[0]
	}
	return r.RemoteAddr
}
