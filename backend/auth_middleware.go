package main

import (
	"context"
	"net/http"
	"strings"
)

type contextKey string

const authUserKey contextKey = "auth_user"

func UserFromContext(ctx context.Context) (*AuthUser, bool) {
	user, ok := ctx.Value(authUserKey).(*AuthUser)
	return user, ok
}

func UserIDFromContext(ctx context.Context) string {
	if user, ok := UserFromContext(ctx); ok {
		return user.ID
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
		if !strings.HasPrefix(path, "/api/") || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}

		cookie, err := r.Cookie(cookieName)
		if err != nil || cookie.Value == "" {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "please log in"})
			return
		}
		user, err := auth.ValidateSession(cookie.Value)
		if err != nil {
			clearTokenCookie(w)
			writeAuthError(w, err, false)
			return
		}

		ctx := context.WithValue(r.Context(), authUserKey, user)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
