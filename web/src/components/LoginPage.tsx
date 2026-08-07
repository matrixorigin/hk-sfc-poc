import { useEffect, useState, type FormEvent } from 'react'
import { AlertCircle, Eye, EyeOff, Lock, LogIn, User } from 'lucide-react'
import { useT } from '../i18n'
import { login, type AuthUser } from '../api/auth'
import './LoginPage.css'

interface Props {
  onLogin: (user: AuthUser) => void
  initialError?: string
}

export function LoginPage({ onLogin, initialError = '' }: Props) {
  const { t } = useT()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(initialError)
  const [loading, setLoading] = useState(false)

  useEffect(() => setError(initialError), [initialError])

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (loading) return
    if (!username.trim() || !password) {
      setError(t('loginRequired'))
      return
    }

    setLoading(true)
    setError('')
    try {
      onLogin(await login(username.trim(), password))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('loginError'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="login-header">
          <div className="login-logo">HK</div>
          <h1 className="login-title">{t('title')}</h1>
          <p className="login-subtitle">{t('loginSubtitle')}</p>
        </div>

        {error ? (
          <div className="login-error" role="alert">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        ) : null}

        <label className="login-field">
          <span className="login-label">{t('username')}</span>
          <div className="login-input-wrap">
            <User size={16} className="login-input-icon" />
            <input
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder={t('username')}
              autoComplete="username"
              autoFocus
              disabled={loading}
            />
          </div>
        </label>

        <label className="login-field">
          <span className="login-label">{t('password')}</span>
          <div className="login-input-wrap">
            <Lock size={16} className="login-input-icon" />
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('password')}
              autoComplete="current-password"
              disabled={loading}
            />
            <button
              type="button"
              className="login-eye"
              onClick={() => setShowPassword((visible) => !visible)}
              aria-label={t(showPassword ? 'hidePassword' : 'showPassword')}
              tabIndex={-1}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </label>

        <button type="submit" className="login-submit" disabled={loading}>
          {loading ? <span className="login-spinner" /> : <LogIn size={18} />}
          <span>{t(loading ? 'loggingIn' : 'loginBtn')}</span>
        </button>

        <p className="login-footnote">{t('registrationClosed')}</p>
      </form>
    </div>
  )
}
