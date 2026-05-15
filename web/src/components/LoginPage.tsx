import { useState, type FormEvent } from 'react'
import { useT } from '../i18n'
import { login, register } from '../api/auth'

interface Props {
  onLogin: (username: string) => void
}

type Mode = 'login' | 'register'

export function LoginPage({ onLogin }: Props) {
  const { t } = useT()
  const [mode, setMode] = useState<Mode>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const switchMode = (m: Mode) => {
    setMode(m)
    setError('')
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError('')

    if (mode === 'register' && password !== confirmPwd) {
      setError(t('passwordMismatch'))
      return
    }

    setLoading(true)
    try {
      const action = mode === 'login' ? login : register
      const user = await action(username, password)
      onLogin(user.username)
    } catch (err) {
      setError(err instanceof Error ? err.message : t(mode === 'login' ? 'loginError' : 'registerError'))
    } finally {
      setLoading(false)
    }
  }

  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: '10px 0',
    cursor: 'pointer',
    background: 'none',
    border: 'none',
    borderBottom: active ? '2px solid #1a1a2e' : '2px solid transparent',
    fontWeight: active ? 600 : 400,
    fontSize: 15,
    color: active ? '#1a1a2e' : '#888',
    transition: 'all 0.2s',
  })

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    border: '1px solid #d0d0d0',
    borderRadius: 6,
    fontSize: 14,
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.2s',
  }

  return (
    <div style={{
      minHeight: '100vh',
      background: '#f5f6fa',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    }}>
      <div style={{
        width: '100%',
        maxWidth: 380,
        background: '#fff',
        borderRadius: 12,
        boxShadow: '0 2px 16px rgba(0,0,0,0.08)',
        padding: '36px 32px 28px',
      }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 48,
            height: 48,
            borderRadius: 10,
            background: '#1a1a2e',
            color: '#fff',
            fontWeight: 700,
            fontSize: 20,
            letterSpacing: 1,
            marginBottom: 10,
          }}>HK</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#1a1a2e' }}>
            {t('title')}
          </div>
        </div>

        <div style={{ display: 'flex', marginBottom: 20, borderBottom: '1px solid #eee' }}>
          <button type="button" style={tabStyle(mode === 'login')} onClick={() => switchMode('login')}>
            {t('login')}
          </button>
          <button type="button" style={tabStyle(mode === 'register')} onClick={() => switchMode('register')}>
            {t('register')}
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#333', marginBottom: 4 }}>
              {t('username')}
            </label>
            <input
              style={inputStyle}
              type="text"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder={t('usernameHint')}
              required
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#333', marginBottom: 4 }}>
              {t('password')}
            </label>
            <input
              style={inputStyle}
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={t('passwordHint')}
              required
            />
          </div>

          {mode === 'register' && (
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontSize: 13, fontWeight: 500, color: '#333', marginBottom: 4 }}>
                {t('confirmPassword')}
              </label>
              <input
                style={inputStyle}
                type="password"
                autoComplete="new-password"
                value={confirmPwd}
                onChange={e => setConfirmPwd(e.target.value)}
                placeholder={t('passwordHint')}
                required
              />
            </div>
          )}

          {error && (
            <div style={{
              color: '#d32f2f',
              fontSize: 13,
              marginBottom: 12,
              padding: '8px 10px',
              background: '#fdecea',
              borderRadius: 6,
            }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '11px 0',
              background: loading ? '#555' : '#1a1a2e',
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: 15,
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              transition: 'background 0.2s',
            }}
          >
            {t(mode === 'login' ? 'loginBtn' : 'registerBtn')}
          </button>
        </form>
      </div>
    </div>
  )
}
