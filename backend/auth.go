package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"
)

var (
	validUsername = regexp.MustCompile(`^[a-zA-Z0-9_]{3,32}$`)
	hasLetter     = regexp.MustCompile(`[a-zA-Z]`)
	hasNumber     = regexp.MustCompile(`[0-9]`)
	hasSpecial    = regexp.MustCompile(`[^a-zA-Z0-9]`)

	ErrInvalidCredentials = errors.New("invalid username or password")
	ErrInvalidSession     = errors.New("invalid session")
	ErrAccountDisabled    = errors.New("account disabled")
	ErrAccountExpired     = errors.New("account expired")
	ErrUsernameTaken      = errors.New("username already taken")
	ErrUserNotFound       = errors.New("user not found")
	ErrAdminFixed         = errors.New("administrator account is fixed")
)

var shanghaiLocation = time.FixedZone("Asia/Shanghai", 8*60*60)

type ValidationError struct {
	Message string
}

func (e *ValidationError) Error() string {
	return e.Message
}

func validationError(message string) error {
	return &ValidationError{Message: message}
}

type AuthUser struct {
	ID        string  `json:"id"`
	Username  string  `json:"username"`
	IsAdmin   bool    `json:"is_admin"`
	IsActive  bool    `json:"is_active"`
	ExpiresAt *string `json:"expires_at"`
	Remark    string  `json:"remark"`
	CreatedAt string  `json:"created_at"`
}

type CreateUserInput struct {
	Username  string
	Password  string
	IsActive  bool
	ExpiresAt *string
	Remark    string
}

type UpdateUserInput struct {
	Password     *string
	IsActive     *bool
	ExpiresAt    *string
	ExpiresAtSet bool
	Remark       *string
}

type AuthService struct {
	db *sql.DB
}

func NewAuthService(db *sql.DB, cfg AuthConfig) (*AuthService, error) {
	if err := validateUsername(cfg.AdminUsername); err != nil {
		return nil, fmt.Errorf("invalid administrator username: %w", err)
	}
	if err := validatePassword(cfg.AdminPassword); err != nil {
		return nil, fmt.Errorf("invalid administrator password: %w", err)
	}

	ddl := []string{
		`CREATE TABLE IF NOT EXISTS poc_users (
			id         VARCHAR(64) PRIMARY KEY,
			username   VARCHAR(32) UNIQUE NOT NULL,
			password   VARCHAR(128) NOT NULL,
			is_admin   BOOLEAN NOT NULL DEFAULT FALSE,
			is_active  BOOLEAN NOT NULL DEFAULT TRUE,
			expires_at DATETIME NULL,
			remark     VARCHAR(255) NULL,
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
	for _, column := range []struct {
		name    string
		typeSQL string
	}{
		{"is_admin", "BOOLEAN NOT NULL DEFAULT FALSE"},
		{"is_active", "BOOLEAN NOT NULL DEFAULT TRUE"},
		{"expires_at", "DATETIME NULL"},
		{"remark", "VARCHAR(255) NULL"},
	} {
		if err := svc.ensureUserColumn(column.name, column.typeSQL); err != nil {
			return nil, err
		}
	}
	if err := svc.syncAdministrator(cfg.AdminUsername, cfg.AdminPassword); err != nil {
		return nil, err
	}

	go svc.cleanupLoop()
	return svc, nil
}

func (a *AuthService) ensureUserColumn(column, typeSQL string) error {
	var count int
	if err := a.db.QueryRow(
		`SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'poc_users' AND column_name = ?`,
		column,
	).Scan(&count); err != nil {
		return fmt.Errorf("check poc_users.%s: %w", column, err)
	}
	if count > 0 {
		return nil
	}
	stmt := fmt.Sprintf("ALTER TABLE poc_users ADD COLUMN %s %s", column, typeSQL)
	log.Printf("[migration] %s", stmt)
	if _, err := a.db.Exec(stmt); err != nil {
		return fmt.Errorf("add poc_users.%s: %w", column, err)
	}
	return nil
}

func (a *AuthService) syncAdministrator(username, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return fmt.Errorf("hash administrator password: %w", err)
	}

	tx, err := a.db.Begin()
	if err != nil {
		return fmt.Errorf("begin administrator sync: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`UPDATE poc_users SET is_admin = FALSE WHERE username <> ? AND is_admin = TRUE`, username); err != nil {
		return fmt.Errorf("demote old administrators: %w", err)
	}

	var id string
	err = tx.QueryRow(`SELECT id FROM poc_users WHERE username = ?`, username).Scan(&id)
	switch {
	case err == sql.ErrNoRows:
		id = newUUID()
		if _, err := tx.Exec(
			`INSERT INTO poc_users (id, username, password, is_admin, is_active, expires_at, remark) VALUES (?, ?, ?, TRUE, TRUE, NULL, NULL)`,
			id, username, string(hash),
		); err != nil {
			return fmt.Errorf("create administrator: %w", err)
		}
	case err != nil:
		return fmt.Errorf("find administrator: %w", err)
	default:
		if _, err := tx.Exec(
			`UPDATE poc_users SET password = ?, is_admin = TRUE, is_active = TRUE, expires_at = NULL WHERE id = ?`,
			string(hash), id,
		); err != nil {
			return fmt.Errorf("update administrator: %w", err)
		}
	}

	// The configured password is authoritative after every restart.
	if _, err := tx.Exec(`DELETE FROM poc_sessions WHERE user_id = ?`, id); err != nil {
		return fmt.Errorf("revoke administrator sessions: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit administrator sync: %w", err)
	}
	log.Printf("administrator account synchronized: %s", username)
	return nil
}

func validateUsername(username string) error {
	if !validUsername.MatchString(strings.TrimSpace(username)) {
		return validationError("username must be 3-32 letters, numbers, or underscore characters")
	}
	return nil
}

func validatePassword(password string) error {
	switch {
	case len(password) < 8:
		return validationError("password must be at least 8 characters")
	case !hasLetter.MatchString(password):
		return validationError("password must contain a letter")
	case !hasNumber.MatchString(password):
		return validationError("password must contain a number")
	case !hasSpecial.MatchString(password):
		return validationError("password must contain a special character")
	default:
		return nil
	}
}

func normalizeRemark(remark string) (string, error) {
	remark = strings.TrimSpace(remark)
	if utf8.RuneCountInString(remark) > 255 {
		return "", validationError("remark must not exceed 255 characters")
	}
	return remark, nil
}

func normalizeExpiresAt(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	layouts := []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02"}
	for _, layout := range layouts {
		var parsed time.Time
		var err error
		if layout == time.RFC3339 {
			parsed, err = time.Parse(layout, value)
			if err == nil {
				parsed = parsed.In(shanghaiLocation)
			}
		} else {
			parsed, err = time.ParseInLocation(layout, value, shanghaiLocation)
		}
		if err != nil {
			continue
		}
		if layout == "2006-01-02" {
			parsed = parsed.Add(23*time.Hour + 59*time.Minute + 59*time.Second)
		}
		return parsed.Format("2006-01-02 15:04:05"), nil
	}
	return "", validationError("invalid expiry date")
}

func (a *AuthService) Login(username, password string) (string, *AuthUser, error) {
	username = strings.TrimSpace(username)
	var hash string
	user, err := scanAuthUserWithPassword(a.db.QueryRow(userSelectWithPasswordSQL+` WHERE username = ?`, username), &hash)
	if err != nil {
		if err == sql.ErrNoRows {
			return "", nil, ErrInvalidCredentials
		}
		return "", nil, fmt.Errorf("query user: %w", err)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)); err != nil {
		return "", nil, ErrInvalidCredentials
	}
	if err := accountAvailability(user); err != nil {
		return "", nil, err
	}

	var tokenBytes [32]byte
	if _, err := rand.Read(tokenBytes[:]); err != nil {
		return "", nil, fmt.Errorf("generate token: %w", err)
	}
	token := hex.EncodeToString(tokenBytes[:])
	expiresAt := time.Now().Add(7 * 24 * time.Hour)
	if _, err := a.db.Exec(
		`INSERT INTO poc_sessions (token, user_id, expires_at) VALUES (?, ?, ?)`,
		token, user.ID, expiresAt,
	); err != nil {
		return "", nil, fmt.Errorf("create session: %w", err)
	}
	return token, user, nil
}

func (a *AuthService) ValidateSession(token string) (*AuthUser, error) {
	user, err := scanAuthUser(a.db.QueryRow(
		`SELECT u.id, u.username, u.is_admin, u.is_active, u.expires_at, u.remark, u.created_at
		 FROM poc_sessions s JOIN poc_users u ON u.id = s.user_id
		 WHERE s.token = ? AND s.expires_at > NOW()`,
		token,
	))
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, ErrInvalidSession
		}
		return nil, fmt.Errorf("validate session: %w", err)
	}
	if err := accountAvailability(user); err != nil {
		return nil, err
	}
	return user, nil
}

func (a *AuthService) ListUsers() ([]AuthUser, error) {
	rows, err := a.db.Query(userSelectSQL + ` ORDER BY is_admin DESC, created_at ASC`)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()

	users := make([]AuthUser, 0)
	for rows.Next() {
		user, err := scanAuthUser(rows)
		if err != nil {
			return nil, fmt.Errorf("scan user: %w", err)
		}
		users = append(users, *user)
	}
	return users, rows.Err()
}

func (a *AuthService) GetUser(id string) (*AuthUser, error) {
	user, err := scanAuthUser(a.db.QueryRow(userSelectSQL+` WHERE id = ?`, id))
	if err == sql.ErrNoRows {
		return nil, ErrUserNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get user: %w", err)
	}
	return user, nil
}

func (a *AuthService) CreateUser(input CreateUserInput) (*AuthUser, error) {
	input.Username = strings.TrimSpace(input.Username)
	if err := validateUsername(input.Username); err != nil {
		return nil, err
	}
	if err := validatePassword(input.Password); err != nil {
		return nil, err
	}
	remark, err := normalizeRemark(input.Remark)
	if err != nil {
		return nil, err
	}
	var expires any
	if input.ExpiresAt != nil {
		normalized, err := normalizeExpiresAt(*input.ExpiresAt)
		if err != nil {
			return nil, err
		}
		if normalized != "" {
			expires = normalized
		}
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(input.Password), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("hash password: %w", err)
	}
	var existing int
	if err := a.db.QueryRow(`SELECT COUNT(*) FROM poc_users WHERE username = ?`, input.Username).Scan(&existing); err != nil {
		return nil, fmt.Errorf("check username: %w", err)
	}
	if existing > 0 {
		return nil, ErrUsernameTaken
	}

	id := newUUID()
	if _, err := a.db.Exec(
		`INSERT INTO poc_users (id, username, password, is_admin, is_active, expires_at, remark) VALUES (?, ?, ?, FALSE, ?, ?, ?)`,
		id, input.Username, string(hash), input.IsActive, expires, nullableString(remark),
	); err != nil {
		return nil, fmt.Errorf("create user: %w", err)
	}
	return a.GetUser(id)
}

func (a *AuthService) UpdateUser(id string, input UpdateUserInput) (*AuthUser, error) {
	current, err := a.GetUser(id)
	if err != nil {
		return nil, err
	}
	if current.IsAdmin {
		return nil, ErrAdminFixed
	}

	setParts := make([]string, 0, 4)
	args := make([]any, 0, 5)
	revokeSessions := false
	if input.Password != nil {
		if err := validatePassword(*input.Password); err != nil {
			return nil, err
		}
		hash, err := bcrypt.GenerateFromPassword([]byte(*input.Password), bcrypt.DefaultCost)
		if err != nil {
			return nil, fmt.Errorf("hash password: %w", err)
		}
		setParts = append(setParts, "password = ?")
		args = append(args, string(hash))
		revokeSessions = true
	}
	if input.IsActive != nil {
		setParts = append(setParts, "is_active = ?")
		args = append(args, *input.IsActive)
		if !*input.IsActive {
			revokeSessions = true
		}
	}
	if input.ExpiresAtSet {
		setParts = append(setParts, "expires_at = ?")
		if input.ExpiresAt == nil || strings.TrimSpace(*input.ExpiresAt) == "" {
			args = append(args, nil)
		} else {
			normalized, err := normalizeExpiresAt(*input.ExpiresAt)
			if err != nil {
				return nil, err
			}
			args = append(args, normalized)
			if isExpiredValue(normalized) {
				revokeSessions = true
			}
		}
	}
	if input.Remark != nil {
		remark, err := normalizeRemark(*input.Remark)
		if err != nil {
			return nil, err
		}
		setParts = append(setParts, "remark = ?")
		args = append(args, nullableString(remark))
	}
	if len(setParts) == 0 {
		return nil, validationError("no supported fields to update")
	}

	tx, err := a.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin user update: %w", err)
	}
	defer tx.Rollback()
	args = append(args, id)
	if _, err := tx.Exec(`UPDATE poc_users SET `+strings.Join(setParts, ", ")+` WHERE id = ?`, args...); err != nil {
		return nil, fmt.Errorf("update user: %w", err)
	}
	if revokeSessions {
		if _, err := tx.Exec(`DELETE FROM poc_sessions WHERE user_id = ?`, id); err != nil {
			return nil, fmt.Errorf("revoke user sessions: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit user update: %w", err)
	}
	return a.GetUser(id)
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

const userSelectSQL = `SELECT id, username, is_admin, is_active, expires_at, remark, created_at FROM poc_users`
const userSelectWithPasswordSQL = `SELECT id, username, is_admin, is_active, expires_at, remark, created_at, password FROM poc_users`

type rowScanner interface {
	Scan(dest ...any) error
}

func scanAuthUser(scanner rowScanner) (*AuthUser, error) {
	var user AuthUser
	var expiresAt, remark sql.NullString
	if err := scanner.Scan(
		&user.ID, &user.Username, &user.IsAdmin, &user.IsActive,
		&expiresAt, &remark, &user.CreatedAt,
	); err != nil {
		return nil, err
	}
	user.ExpiresAt = jsonDateTime(expiresAt)
	user.Remark = remark.String
	user.CreatedAt = strings.Replace(user.CreatedAt, " ", "T", 1)
	return &user, nil
}

func scanAuthUserWithPassword(scanner rowScanner, password *string) (*AuthUser, error) {
	var user AuthUser
	var expiresAt, remark sql.NullString
	if err := scanner.Scan(
		&user.ID, &user.Username, &user.IsAdmin, &user.IsActive,
		&expiresAt, &remark, &user.CreatedAt, password,
	); err != nil {
		return nil, err
	}
	user.ExpiresAt = jsonDateTime(expiresAt)
	user.Remark = remark.String
	user.CreatedAt = strings.Replace(user.CreatedAt, " ", "T", 1)
	return &user, nil
}

func jsonDateTime(value sql.NullString) *string {
	if !value.Valid || value.String == "" {
		return nil
	}
	formatted := strings.Replace(value.String, " ", "T", 1)
	return &formatted
}

func accountAvailability(user *AuthUser) error {
	if !user.IsActive {
		return ErrAccountDisabled
	}
	if user.ExpiresAt != nil && isExpiredValue(*user.ExpiresAt) {
		return ErrAccountExpired
	}
	return nil
}

func isExpiredValue(value string) bool {
	value = strings.Replace(value, "T", " ", 1)
	parsed, err := time.ParseInLocation("2006-01-02 15:04:05", value, shanghaiLocation)
	return err == nil && parsed.Before(time.Now().In(shanghaiLocation))
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
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
