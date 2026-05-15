package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"time"

	"golang.org/x/crypto/bcrypt"
)

var validUsername = regexp.MustCompile(`^[a-zA-Z0-9_]{3,32}$`)

type AuthService struct {
	db *sql.DB
}

func NewAuthService(db *sql.DB) (*AuthService, error) {
	ddl := []string{
		`CREATE TABLE IF NOT EXISTS poc_users (
			id         VARCHAR(64) PRIMARY KEY,
			username   VARCHAR(32) UNIQUE NOT NULL,
			password   VARCHAR(128) NOT NULL,
			created_at DATETIME DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS poc_sessions (
			token      VARCHAR(128) PRIMARY KEY,
			user_id    VARCHAR(64) NOT NULL,
			expires_at DATETIME NOT NULL
		)`,
	}
	for _, q := range ddl {
		if _, err := db.Exec(q); err != nil {
			return nil, fmt.Errorf("auth ddl: %w", err)
		}
	}
	svc := &AuthService{db: db}
	go svc.cleanupLoop()
	return svc, nil
}

func (a *AuthService) Register(username, password string) error {
	if !validUsername.MatchString(username) {
		return fmt.Errorf("username must be 3-32 alphanumeric or underscore characters")
	}
	if len(password) < 6 {
		return fmt.Errorf("password must be at least 6 characters")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	id := newUUID()
	_, err = a.db.Exec("INSERT INTO poc_users (id, username, password) VALUES (?, ?, ?)", id, username, string(hash))
	if err != nil {
		return fmt.Errorf("username already taken")
	}
	return nil
}

func (a *AuthService) Login(username, password string) (string, error) {
	var id, hash string
	err := a.db.QueryRow("SELECT id, password FROM poc_users WHERE username = ?", username).Scan(&id, &hash)
	if err != nil {
		return "", fmt.Errorf("invalid username or password")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)); err != nil {
		return "", fmt.Errorf("invalid username or password")
	}
	var tokenBytes [32]byte
	if _, err := rand.Read(tokenBytes[:]); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	token := hex.EncodeToString(tokenBytes[:])
	expiresAt := time.Now().Add(7 * 24 * time.Hour)
	_, err = a.db.Exec("INSERT INTO poc_sessions (token, user_id, expires_at) VALUES (?, ?, ?)", token, id, expiresAt)
	if err != nil {
		return "", fmt.Errorf("create session: %w", err)
	}
	return token, nil
}

func (a *AuthService) ValidateSession(token string) (string, bool) {
	var userID string
	err := a.db.QueryRow("SELECT user_id FROM poc_sessions WHERE token = ? AND expires_at > NOW()", token).Scan(&userID)
	if err != nil {
		return "", false
	}
	return userID, true
}

func (a *AuthService) GetUsername(userID string) (string, error) {
	var username string
	err := a.db.QueryRow("SELECT username FROM poc_users WHERE id = ?", userID).Scan(&username)
	return username, err
}

func (a *AuthService) Logout(token string) {
	_, _ = a.db.Exec("DELETE FROM poc_sessions WHERE token = ?", token)
}

func (a *AuthService) cleanupLoop() {
	ticker := time.NewTicker(1 * time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		res, err := a.db.Exec("DELETE FROM poc_sessions WHERE expires_at <= NOW()")
		if err != nil {
			log.Printf("cleanup expired sessions: %v", err)
			continue
		}
		if n, _ := res.RowsAffected(); n > 0 {
			log.Printf("cleaned up %d expired session(s)", n)
		}
	}
}

const cookieName = "poc_token"
const cookieMaxAge = 7 * 24 * 60 * 60

func setTokenCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   cookieMaxAge,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

func clearTokenCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}
