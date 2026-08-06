package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	"golang.org/x/crypto/bcrypt"
)

func TestValidateCredentials(t *testing.T) {
	for _, username := range []string{"abc", "user_01", "ADMIN"} {
		if err := validateUsername(username); err != nil {
			t.Fatalf("expected valid username %q: %v", username, err)
		}
	}
	for _, username := range []string{"ab", "has-dash", "has space", ""} {
		if err := validateUsername(username); err == nil {
			t.Fatalf("expected invalid username %q", username)
		}
	}

	if err := validatePassword("Good@123"); err != nil {
		t.Fatalf("expected valid password: %v", err)
	}
	for _, password := range []string{"Short1!", "onlyletters!", "12345678!", "Letters123"} {
		if err := validatePassword(password); err == nil {
			t.Fatalf("expected invalid password %q", password)
		}
	}
}

func TestEnsureUserColumnIsIdempotent(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	svc := &AuthService{db: db}

	checkQuery := regexp.QuoteMeta(`SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'poc_users' AND column_name = ?`)
	mock.ExpectQuery(checkQuery).WithArgs("is_admin").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(1))
	if err := svc.ensureUserColumn("is_admin", "BOOLEAN NOT NULL DEFAULT FALSE"); err != nil {
		t.Fatal(err)
	}

	mock.ExpectQuery(checkQuery).WithArgs("remark").WillReturnRows(sqlmock.NewRows([]string{"count"}).AddRow(0))
	mock.ExpectExec(regexp.QuoteMeta("ALTER TABLE poc_users ADD COLUMN remark VARCHAR(255) NULL")).WillReturnResult(sqlmock.NewResult(0, 0))
	if err := svc.ensureUserColumn("remark", "VARCHAR(255) NULL"); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestSyncAdministratorCreatesThenUpdates(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	svc := &AuthService{db: db}

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE poc_users SET is_admin = FALSE WHERE username <> ? AND is_admin = TRUE`)).WithArgs("admin").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(regexp.QuoteMeta(`SELECT id FROM poc_users WHERE username = ?`)).WithArgs("admin").WillReturnError(sqlmock.ErrCancelled)
	if err := svc.syncAdministrator("admin", "User@123"); err == nil {
		t.Fatal("expected query failure to be returned")
	}

	// Fresh service expectations for the create path.
	db2, mock2, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	svc2 := &AuthService{db: db2}
	mock2.ExpectBegin()
	mock2.ExpectExec(regexp.QuoteMeta(`UPDATE poc_users SET is_admin = FALSE WHERE username <> ? AND is_admin = TRUE`)).WithArgs("admin").WillReturnResult(sqlmock.NewResult(0, 1))
	mock2.ExpectQuery(regexp.QuoteMeta(`SELECT id FROM poc_users WHERE username = ?`)).WithArgs("admin").WillReturnRows(sqlmock.NewRows([]string{"id"}))
	mock2.ExpectExec(regexp.QuoteMeta(`INSERT INTO poc_users (id, username, password, is_admin, is_active, expires_at, remark) VALUES (?, ?, ?, TRUE, TRUE, NULL, NULL)`)).WithArgs(sqlmock.AnyArg(), "admin", sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(1, 1))
	mock2.ExpectExec(regexp.QuoteMeta(`DELETE FROM poc_sessions WHERE user_id = ?`)).WithArgs(sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 0))
	mock2.ExpectCommit()
	if err := svc2.syncAdministrator("admin", "User@123"); err != nil {
		t.Fatal(err)
	}

	mock2.ExpectBegin()
	mock2.ExpectExec(regexp.QuoteMeta(`UPDATE poc_users SET is_admin = FALSE WHERE username <> ? AND is_admin = TRUE`)).WithArgs("admin").WillReturnResult(sqlmock.NewResult(0, 0))
	mock2.ExpectQuery(regexp.QuoteMeta(`SELECT id FROM poc_users WHERE username = ?`)).WithArgs("admin").WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow("admin-id"))
	mock2.ExpectExec(regexp.QuoteMeta(`UPDATE poc_users SET password = ?, is_admin = TRUE, is_active = TRUE, expires_at = NULL WHERE id = ?`)).WithArgs(sqlmock.AnyArg(), "admin-id").WillReturnResult(sqlmock.NewResult(0, 1))
	mock2.ExpectExec(regexp.QuoteMeta(`DELETE FROM poc_sessions WHERE user_id = ?`)).WithArgs("admin-id").WillReturnResult(sqlmock.NewResult(0, 1))
	mock2.ExpectCommit()
	if err := svc2.syncAdministrator("admin", "User@123"); err != nil {
		t.Fatal(err)
	}
	if err := mock2.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestLoginRejectsUnavailableAccounts(t *testing.T) {
	hash, err := bcrypt.GenerateFromPassword([]byte("User@123"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	columns := []string{"id", "username", "is_admin", "is_active", "expires_at", "remark", "created_at", "password"}

	for _, tc := range []struct {
		name      string
		active    bool
		expiresAt any
		wantErr   error
	}{
		{"disabled", false, nil, ErrAccountDisabled},
		{"expired", true, "2020-01-01 23:59:59", ErrAccountExpired},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			svc := &AuthService{db: db}
			mock.ExpectQuery(regexp.QuoteMeta(userSelectWithPasswordSQL + ` WHERE username = ?`)).WithArgs("user_01").WillReturnRows(
				sqlmock.NewRows(columns).AddRow("id-1", "user_01", false, tc.active, tc.expiresAt, nil, "2026-01-01 10:00:00", string(hash)),
			)
			_, _, gotErr := svc.Login("user_01", "User@123")
			if !errors.Is(gotErr, tc.wantErr) {
				t.Fatalf("got %v, want %v", gotErr, tc.wantErr)
			}
		})
	}
}

func TestUpdatePasswordRevokesSessions(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	svc := &AuthService{db: db}
	columns := []string{"id", "username", "is_admin", "is_active", "expires_at", "remark", "created_at"}
	userRow := func() *sqlmock.Rows {
		return sqlmock.NewRows(columns).AddRow("user-id", "user_01", false, true, nil, "team", "2026-01-01 10:00:00")
	}
	mock.ExpectQuery(regexp.QuoteMeta(userSelectSQL + ` WHERE id = ?`)).WithArgs("user-id").WillReturnRows(userRow())
	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`UPDATE poc_users SET password = ? WHERE id = ?`)).WithArgs(sqlmock.AnyArg(), "user-id").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(regexp.QuoteMeta(`DELETE FROM poc_sessions WHERE user_id = ?`)).WithArgs("user-id").WillReturnResult(sqlmock.NewResult(0, 2))
	mock.ExpectCommit()
	mock.ExpectQuery(regexp.QuoteMeta(userSelectSQL + ` WHERE id = ?`)).WithArgs("user-id").WillReturnRows(userRow())
	password := "New@1234"
	if _, err := svc.UpdateUser("user-id", UpdateUserInput{Password: &password}); err != nil {
		t.Fatal(err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestOrdinaryUserCannotAccessUserManagement(t *testing.T) {
	handler := NewAuthHandler(&AuthService{})
	request := httptest.NewRequest(http.MethodGet, "/api/users", nil)
	request = request.WithContext(context.WithValue(request.Context(), authUserKey, &AuthUser{ID: "user-id", IsAdmin: false}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("got status %d, want %d", recorder.Code, http.StatusForbidden)
	}
}

func TestRegistrationIsDisabled(t *testing.T) {
	handler := NewAuthHandler(&AuthService{})
	request := httptest.NewRequest(http.MethodPost, "/api/auth/register", nil)
	recorder := httptest.NewRecorder()
	handler.RegisterDisabled(recorder, request)
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("got status %d, want %d", recorder.Code, http.StatusForbidden)
	}
}
