package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type AuthHandler struct {
	auth *AuthService
}

func NewAuthHandler(auth *AuthService) *AuthHandler {
	return &AuthHandler{auth: auth}
}

func (h *AuthHandler) RegisterDisabled(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	writeJSON(w, http.StatusForbidden, map[string]string{"error": "registration is disabled; contact an administrator"})
}

func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	if strings.TrimSpace(req.Username) == "" || req.Password == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "username and password are required"})
		return
	}
	token, user, err := h.auth.Login(req.Username, req.Password)
	if err != nil {
		writeAuthError(w, err, true)
		return
	}
	setTokenCookie(w, token)
	writeJSON(w, http.StatusOK, user)
}

func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	if cookie, err := r.Cookie(cookieName); err == nil {
		h.auth.Logout(cookie.Value)
	}
	clearTokenCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	cookie, err := r.Cookie(cookieName)
	if err != nil || cookie.Value == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	user, err := h.auth.ValidateSession(cookie.Value)
	if err != nil {
		clearTokenCookie(w)
		writeAuthError(w, err, false)
		return
	}
	writeJSON(w, http.StatusOK, user)
}

func (h *AuthHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	setCORSHeaders(w)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	current, ok := UserFromContext(r.Context())
	if !ok || !current.IsAdmin {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "administrator permission required"})
		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/api/users")
	if path == "" || path == "/" {
		switch r.Method {
		case http.MethodGet:
			h.listUsers(w)
		case http.MethodPost:
			h.createUser(w, r)
		default:
			writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		}
		return
	}

	id := strings.Trim(path, "/")
	if id == "" || strings.Contains(id, "/") {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found"})
		return
	}
	if r.Method != http.MethodPatch {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "method not allowed"})
		return
	}
	h.updateUser(w, r, id)
}

func (h *AuthHandler) listUsers(w http.ResponseWriter) {
	users, err := h.auth.ListUsers()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "failed to load users"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

func (h *AuthHandler) createUser(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username  string  `json:"username"`
		Password  string  `json:"password"`
		IsActive  *bool   `json:"is_active"`
		ExpiresAt *string `json:"expires_at"`
		Remark    string  `json:"remark"`
	}
	if err := decodeJSON(w, r, &req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	isActive := true
	if req.IsActive != nil {
		isActive = *req.IsActive
	}
	user, err := h.auth.CreateUser(CreateUserInput{
		Username: req.Username, Password: req.Password, IsActive: isActive,
		ExpiresAt: req.ExpiresAt, Remark: req.Remark,
	})
	if err != nil {
		writeAuthError(w, err, false)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"user": user})
}

func (h *AuthHandler) updateUser(w http.ResponseWriter, r *http.Request, id string) {
	var raw map[string]json.RawMessage
	if err := decodeJSON(w, r, &raw); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return
	}
	for field := range raw {
		switch field {
		case "password", "is_active", "expires_at", "remark":
		default:
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported field: " + field})
			return
		}
	}
	var input UpdateUserInput
	if value, ok := raw["password"]; ok {
		var password string
		if err := json.Unmarshal(value, &password); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "password must be a string"})
			return
		}
		input.Password = &password
	}
	if value, ok := raw["is_active"]; ok {
		var active bool
		if err := json.Unmarshal(value, &active); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "is_active must be a boolean"})
			return
		}
		input.IsActive = &active
	}
	if value, ok := raw["expires_at"]; ok {
		input.ExpiresAtSet = true
		if !bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			var expiresAt string
			if err := json.Unmarshal(value, &expiresAt); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "expires_at must be a date string or null"})
				return
			}
			input.ExpiresAt = &expiresAt
		}
	}
	if value, ok := raw["remark"]; ok {
		var remark string
		if err := json.Unmarshal(value, &remark); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "remark must be a string"})
			return
		}
		input.Remark = &remark
	}

	user, err := h.auth.UpdateUser(id, input)
	if err != nil {
		writeAuthError(w, err, false)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func writeAuthError(w http.ResponseWriter, err error, login bool) {
	status := http.StatusInternalServerError
	message := "internal server error"
	var validationErr *ValidationError
	switch {
	case errors.As(err, &validationErr):
		status = http.StatusBadRequest
		message = validationErr.Message
	case errors.Is(err, ErrInvalidCredentials):
		status = http.StatusUnauthorized
		message = "invalid username or password"
	case errors.Is(err, ErrInvalidSession):
		status = http.StatusUnauthorized
		message = "login expired; please log in again"
	case errors.Is(err, ErrAccountDisabled):
		if login {
			status = http.StatusForbidden
		} else {
			status = http.StatusUnauthorized
		}
		message = "account has been disabled; contact an administrator"
	case errors.Is(err, ErrAccountExpired):
		if login {
			status = http.StatusForbidden
		} else {
			status = http.StatusUnauthorized
		}
		message = "account has expired; contact an administrator"
	case errors.Is(err, ErrUsernameTaken):
		status = http.StatusConflict
		message = "username already exists"
	case errors.Is(err, ErrUserNotFound):
		status = http.StatusNotFound
		message = "user not found"
	case errors.Is(err, ErrAdminFixed):
		message = "administrator account is fixed and cannot be modified"
	}
	writeJSON(w, status, map[string]string{"error": message})
}
