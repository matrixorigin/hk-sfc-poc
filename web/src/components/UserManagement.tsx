import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  UserPlus,
  X,
} from 'lucide-react'
import type { AuthUser } from '../api/auth'
import {
  createUser,
  listUsers,
  updateUser,
  type CreateUserPayload,
  type UpdateUserPayload,
} from '../api/users'
import { useT } from '../i18n'
import './UserManagement.css'

const USERNAME_PATTERN = /^[A-Za-z0-9_]{3,32}$/

const emptyForm: CreateUserPayload & { expiresDate: string } = {
  username: '',
  password: '',
  expires_at: null,
  expiresDate: '',
  is_active: true,
  remark: '',
}

interface Props {
  onClose: () => void
}

function toExpiresAt(date: string): string | null {
  return date ? `${date}T23:59:59` : null
}

function toDateInput(value: string | null): string {
  return value ? value.slice(0, 10) : ''
}

function formatDateTime(value: string | null): string {
  return value ? value.slice(0, 16).replace('T', ' ') : '—'
}

function isExpired(user: AuthUser): boolean {
  return Boolean(user.expires_at) && new Date(user.expires_at as string).getTime() < Date.now()
}

export function UserManagement({ onClose }: Props) {
  const { t } = useT()
  const [users, setUsers] = useState<AuthUser[]>([])
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [form, setForm] = useState(emptyForm)
  const [passwordFor, setPasswordFor] = useState<AuthUser | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const showNotice = useCallback((type: 'ok' | 'err', text: string) => {
    setNotice({ type, text })
  }, [])

  const loadUsers = useCallback(async () => {
    setLoading(true)
    try {
      setUsers(await listUsers())
    } catch (err) {
      showNotice('err', err instanceof Error ? err.message : t('userLoadError'))
    } finally {
      setLoading(false)
    }
  }, [showNotice, t])

  useEffect(() => {
    void loadUsers()
  }, [loadUsers])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 3000)
    return () => window.clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (passwordFor) setPasswordFor(null)
      else if (createOpen) setCreateOpen(false)
      else onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [createOpen, onClose, passwordFor])

  const validateUsername = (username: string): string => {
    if (!USERNAME_PATTERN.test(username)) return t('usernameHint')
    return ''
  }

  const validatePassword = (password: string): string => {
    if (password.length < 8) return t('passwordMin8')
    if (!/[A-Za-z]/.test(password)) return t('passwordNeedsLetter')
    if (!/\d/.test(password)) return t('passwordNeedsNumber')
    if (!/[^A-Za-z0-9]/.test(password)) return t('passwordNeedsSpecial')
    return ''
  }

  const patchUser = async (user: AuthUser, changes: UpdateUserPayload, message: string) => {
    try {
      const updated = await updateUser(user.id, changes)
      setUsers((current) => current.map((item) => item.id === updated.id ? updated : item))
      showNotice('ok', message)
    } catch (err) {
      showNotice('err', err instanceof Error ? err.message : t('userUpdateError'))
    }
  }

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault()
    const username = form.username.trim()
    const usernameError = validateUsername(username)
    if (usernameError) return showNotice('err', usernameError)
    const passwordError = validatePassword(form.password)
    if (passwordError) return showNotice('err', passwordError)

    setSubmitting(true)
    try {
      await createUser({
        username,
        password: form.password,
        expires_at: toExpiresAt(form.expiresDate),
        is_active: form.is_active,
        remark: form.remark,
      })
      showNotice('ok', `${t('userCreated')}: ${username}`)
      setCreateOpen(false)
      setForm(emptyForm)
      await loadUsers()
    } catch (err) {
      showNotice('err', err instanceof Error ? err.message : t('userCreateError'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleResetPassword = async (event: FormEvent) => {
    event.preventDefault()
    if (!passwordFor) return
    const passwordError = validatePassword(newPassword)
    if (passwordError) return showNotice('err', passwordError)

    setSubmitting(true)
    try {
      await updateUser(passwordFor.id, { password: newPassword })
      showNotice('ok', `${t('passwordResetDone')}: ${passwordFor.username}`)
      setPasswordFor(null)
      setNewPassword('')
    } catch (err) {
      showNotice('err', err instanceof Error ? err.message : t('passwordResetError'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="um-overlay" onClick={onClose}>
      <section className="um-modal" onClick={(event) => event.stopPropagation()} aria-modal="true" role="dialog">
        <header className="um-header">
          <div className="um-header-title">
            <ShieldCheck size={18} />
            <h2>{t('userManagement')}</h2>
          </div>
          <div className="um-header-actions">
            <button className="um-btn" onClick={() => void loadUsers()} disabled={loading}>
              <RefreshCw size={15} className={loading ? 'um-spin' : ''} />
              <span>{t('refresh')}</span>
            </button>
            <button className="um-btn um-btn-primary" onClick={() => setCreateOpen(true)}>
              <UserPlus size={15} />
              <span>{t('createUser')}</span>
            </button>
            <button className="um-icon-btn" onClick={onClose} aria-label={t('close')}>
              <X size={18} />
            </button>
          </div>
        </header>

        {notice ? (
          <div className={`um-notice ${notice.type}`} role="status">
            {notice.type === 'ok' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
            <span>{notice.text}</span>
          </div>
        ) : null}

        <div className="um-body">
          <table className="um-table">
            <thead>
              <tr>
                <th>{t('username')}</th>
                <th>{t('userStatus')}</th>
                <th>{t('userExpiry')}</th>
                <th>{t('userEnabled')}</th>
                <th>{t('userRemark')}</th>
                <th>{t('createdAt')}</th>
                <th>{t('actions')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <span className="um-username">{user.username}</span>
                    {user.is_admin ? <span className="um-tag gold">{t('administrator')}</span> : null}
                  </td>
                  <td>
                    {!user.is_active ? (
                      <span className="um-tag">{t('userDisabled')}</span>
                    ) : isExpired(user) ? (
                      <span className="um-tag red">{t('userExpired')}</span>
                    ) : (
                      <span className="um-tag green">{t('userNormal')}</span>
                    )}
                  </td>
                  <td>
                    {user.is_admin ? (
                      <span className="um-muted">{t('longTerm')}</span>
                    ) : (
                      <input
                        type="date"
                        className="um-date"
                        value={toDateInput(user.expires_at)}
                        onChange={(event) => void patchUser(
                          user,
                          { expires_at: toExpiresAt(event.target.value) },
                          t('expiryUpdated')
                        )}
                        aria-label={`${user.username} ${t('userExpiry')}`}
                      />
                    )}
                  </td>
                  <td>
                    {user.is_admin ? (
                      <span className="um-muted">—</span>
                    ) : (
                      <label className="um-switch">
                        <input
                          type="checkbox"
                          checked={user.is_active}
                          onChange={(event) => void patchUser(
                            user,
                            { is_active: event.target.checked },
                            event.target.checked ? t('userEnabledDone') : t('userDisabledDone')
                          )}
                          aria-label={`${user.username} ${t('userEnabled')}`}
                        />
                        <span className="um-slider" />
                      </label>
                    )}
                  </td>
                  <td>
                    {user.is_admin ? (
                      <span className="um-muted">—</span>
                    ) : (
                      <input
                        key={`${user.id}:${user.remark}`}
                        type="text"
                        className="um-remark"
                        defaultValue={user.remark}
                        maxLength={255}
                        placeholder={t('notProvided')}
                        onBlur={(event) => {
                          const remark = event.target.value.trim()
                          if (remark !== user.remark) void patchUser(user, { remark }, t('remarkUpdated'))
                        }}
                      />
                    )}
                  </td>
                  <td className="um-muted">{formatDateTime(user.created_at)}</td>
                  <td>
                    {user.is_admin ? (
                      <span className="um-muted">{t('fixedAccount')}</span>
                    ) : (
                      <button className="um-link" onClick={() => setPasswordFor(user)}>
                        <KeyRound size={14} />
                        <span>{t('resetPassword')}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {users.length === 0 && !loading ? (
                <tr><td colSpan={7} className="um-empty">{t('noUsers')}</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {createOpen ? (
        <div className="um-dialog-overlay" onClick={(event) => { event.stopPropagation(); setCreateOpen(false) }}>
          <form className="um-dialog" onClick={(event) => event.stopPropagation()} onSubmit={handleCreate}>
            <div className="um-dialog-header">
              <h3>{t('createUser')}</h3>
              <button type="button" className="um-icon-btn" onClick={() => setCreateOpen(false)} aria-label={t('close')}>
                <X size={16} />
              </button>
            </div>
            <label className="um-field">
              <span>{t('username')}</span>
              <input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} autoComplete="off" autoFocus />
              <small>{t('usernameHint')}</small>
            </label>
            <label className="um-field">
              <span>{t('password')}</span>
              <input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} autoComplete="new-password" />
              <small>{t('passwordPolicy')}</small>
            </label>
            <label className="um-field">
              <span>{t('userExpiry')}</span>
              <input type="date" value={form.expiresDate} onChange={(event) => setForm({ ...form, expiresDate: event.target.value })} />
              <small>{t('expiryHint')}</small>
            </label>
            <label className="um-field">
              <span>{t('userRemark')}</span>
              <textarea rows={2} maxLength={255} value={form.remark} onChange={(event) => setForm({ ...form, remark: event.target.value })} placeholder={t('remarkHint')} />
            </label>
            <div className="um-field-inline">
              <label className="um-switch">
                <input type="checkbox" checked={form.is_active} onChange={(event) => setForm({ ...form, is_active: event.target.checked })} />
                <span className="um-slider" />
              </label>
              <span>{t('enableAfterCreate')}</span>
            </div>
            <div className="um-dialog-footer">
              <button type="button" className="um-btn" onClick={() => setCreateOpen(false)}>{t('cancel')}</button>
              <button type="submit" className="um-btn um-btn-primary" disabled={submitting}>{t(submitting ? 'creatingUser' : 'create')}</button>
            </div>
          </form>
        </div>
      ) : null}

      {passwordFor ? (
        <div className="um-dialog-overlay" onClick={(event) => { event.stopPropagation(); setPasswordFor(null) }}>
          <form className="um-dialog" onClick={(event) => event.stopPropagation()} onSubmit={handleResetPassword}>
            <div className="um-dialog-header">
              <h3>{t('resetPassword')}: {passwordFor.username}</h3>
              <button type="button" className="um-icon-btn" onClick={() => setPasswordFor(null)} aria-label={t('close')}><X size={16} /></button>
            </div>
            <label className="um-field">
              <span>{t('newPassword')}</span>
              <input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" autoFocus />
              <small>{t('passwordPolicy')}</small>
            </label>
            <div className="um-dialog-footer">
              <button type="button" className="um-btn" onClick={() => setPasswordFor(null)}>{t('cancel')}</button>
              <button type="submit" className="um-btn um-btn-primary" disabled={submitting}>{t(submitting ? 'resettingPassword' : 'reset')}</button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  )
}
