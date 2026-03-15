package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Password hashing (SHA-256 + salt)

func HashPassword(password string) string {
	salt := make([]byte, 16)
	rand.Read(salt)
	saltHex := hex.EncodeToString(salt)
	h := sha256.Sum256([]byte(saltHex + password))
	return fmt.Sprintf("%s$%x", saltHex, h)
}

func VerifyPassword(password, hashed string) bool {
	if hashed == "" {
		return true // no password set
	}
	// split "salt$hash"
	for i, c := range hashed {
		if c == '$' {
			salt := hashed[:i]
			expectedHash := hashed[i+1:]
			h := sha256.Sum256([]byte(salt + password))
			return fmt.Sprintf("%x", h) == expectedHash
		}
	}
	return false
}

// JWT temporary tokens for password-verified access

func CreateShareToken(linkID, secret string) (string, error) {
	claims := jwt.MapClaims{
		"sub":  linkID,
		"type": "share",
		"exp":  time.Now().Add(30 * time.Minute).Unix(),
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString([]byte(secret))
}

func VerifyShareToken(tokenStr, secret string) (string, bool) {
	token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
		return []byte(secret), nil
	})
	if err != nil || !token.Valid {
		return "", false
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return "", false
	}
	if claims["type"] != "share" {
		return "", false
	}
	sub, ok := claims["sub"].(string)
	return sub, ok
}

// Cookie helpers

func SetShareCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     "share_token",
		Value:    token,
		Path:     "/",
		MaxAge:   1800, // 30 minutes
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

func GetShareCookie(r *http.Request) string {
	c, err := r.Cookie("share_token")
	if err != nil {
		return ""
	}
	return c.Value
}

// API Key helpers

func GenerateAPIKey() string {
	b := make([]byte, 24)
	rand.Read(b)
	return "sk_" + hex.EncodeToString(b)
}
