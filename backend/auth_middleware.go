package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

type contextKey string

const userIDKey contextKey = "user_id"

func UserIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(userIDKey).(string); ok {
		return v
	}
	return ""
}

func authMiddleware(auth *AuthService, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		if strings.HasPrefix(path, "/api/auth/") || path == "/api/auth" {
			next.ServeHTTP(w, r)
			return
		}
		if !strings.HasPrefix(path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}
		if r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}

		cookie, err := r.Cookie(cookieName)
		if err != nil || cookie.Value == "" {
			writeUnauthorized(w)
			return
		}
		userID, ok := auth.ValidateSession(cookie.Value)
		if !ok {
			writeUnauthorized(w)
			return
		}

		ctx := context.WithValue(r.Context(), userIDKey, userID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func writeUnauthorized(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"})
}
