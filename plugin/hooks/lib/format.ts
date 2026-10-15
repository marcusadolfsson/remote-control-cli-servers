// Words and numbers as the pane shows them.

import type { RemoteAccount, RemoteSession } from './wire'

/** 1024-based, one decimal under 10: `512 B`, `3.4 MB`, `74 MB`. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const shown = unit === 0 || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10
  return `${shown} ${units[unit]}`
}

/** `just now`, `5 min ago`, `3 h ago`, `2 d ago`. */
export function relativeTime(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const minutes = Math.round((now - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/** How long a sign-in has left: `12 days left`, `less than 2 hours left`, `expired`. */
export function signInLeft(until: string | null | undefined, now: number): string | null {
  if (!until) return null
  const then = Date.parse(until)
  if (Number.isNaN(then)) return null
  const hours = (then - now) / 3_600_000
  if (hours <= 0) return 'expired'
  if (hours < 2) return 'less than 2 hours left'
  if (hours < 48) return `${Math.floor(hours)} hours left`
  const days = Math.floor(hours / 24)
  return days === 1 ? '1 day left' : `${days} days left`
}

/** `~/…` for a path under the host's home. */
export function shortenHome(path: string | null | undefined, home: string | null | undefined): string {
  if (!path) return ''
  if (!home) return path
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** The last part of a path. */
export function folderName(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** A session's title, else its last prompt, else the start of its id. */
export function sessionTitle(session: Pick<RemoteSession, 'id' | 'title' | 'lastPrompt'>): string {
  return session.title?.trim() || session.lastPrompt?.trim() || session.id.slice(0, 8)
}

/** `2.1.282 → 2.1.287` for a session or Remote Control server waiting on a restart to update. */
export function updateVersions(
  running: Pick<RemoteSession, 'updatePending' | 'claudeVersion' | 'installedVersion'>,
): string | null {
  if (!running.updatePending) return null
  return `${running.claudeVersion ?? 'older'} → ${running.installedVersion ?? 'newer'}`
}

/** An archive stamp (`20261002-142535`) as a time. */
export function stampToIso(stamp: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp)
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null
}

/** `1 session`, `3 sessions`. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** What an account line says after its name: email, plan, time left; or signed out. */
export function accountLine(account: RemoteAccount, now: number): string {
  if (!account.signedIn) return 'signed out'
  const parts = [
    account.account?.email ?? account.account?.name ?? null,
    account.account?.plan ?? null,
    signInLeft(account.signedInUntil, now),
  ]
  return parts.filter(Boolean).join(' · ')
}

/** Claude Code's version without its suffix: `2.1.287`. */
export function claudeVersion(version: string | null | undefined): string | null {
  return version ? (version.split(' ')[0] ?? version) : null
}

/** A sign-in's time left, short: `20d`, `5h`, `<1h`, `expired`. */
export function shortLeft(until: string | null | undefined, now: number): string | null {
  if (!until) return null
  const then = Date.parse(until)
  if (Number.isNaN(then)) return null
  const hours = (then - now) / 3_600_000
  if (hours <= 0) return 'expired'
  if (hours < 1) return '<1h'
  if (hours < 48) return `${Math.floor(hours)}h`
  return `${Math.floor(hours / 24)}d`
}
