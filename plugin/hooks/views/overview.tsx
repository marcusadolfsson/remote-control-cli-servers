// The main pane: a summary, then each host as a section with a header band,
// its profiles and their sessions as rows of a table. Select a host, a
// profile or a session (click it) for its actions.
//
// Mods draw with terminal cells (the desktop draws the same elements
// natively), so the design leans on what reads well there: colour pills for
// counts and states, filled bands for headers, aligned columns, and one
// accent colour (Claude's). Each host, profile and session has a ⋯ menu of its actions.

import type {
  ArchivedSession,
  ConductorAccount,
  ConductorHost,
  ConductorNote,
  ConductorSelection,
  ConductorTarget,
  ConductorView,
  RcServer,
  RemoteSession,
} from '../../types'
import type { Act, Ui } from './act'

import {
  claudeVersion,
  count,
  folderName,
  formatBytes,
  relativeTime,
  sessionTitle,
  shortenHome,
  shortLeft,
  stampToIso,
  updateVersions,
} from '../lib/format'
import { Icon, type IconName } from './icons'

/** Previous sessions shown before "Show all". */
const PREVIOUS_SHOWN = 8

export type OverviewModel = {
  view: ConductorView
  selected: ConductorSelection | null
  archived: Record<string, Array<ArchivedSession>>
  showAll: Array<string>
  busy: string | null
  note: ConductorNote | null
  /** The ⋯ menu that's open (`hm-…`, `am-…`, `sm-…`). */
  openMenu: string | null
  now: number
  /** The pane's body width, in cells. */
  columns: number
}

type Tone = 'success' | 'warning' | 'error' | 'permission' | 'claude' | 'inactive'

const accountKey = (hostId: string, account: string) => `${hostId}/${account}`

/** The session's state as a glyph and its colour. */
function sessionState(session: RemoteSession): { icon: IconName; tone: Tone } {
  if (session.running && session.waiting) return { icon: 'waiting', tone: 'warning' }
  if (session.running) return { icon: 'running', tone: 'success' }
  return { icon: 'stopped', tone: 'inactive' }
}

function age(updatedAt: number | null, now: number): string {
  if (updatedAt === null) return 'Reading…'
  const seconds = Math.round((now - updatedAt) / 1000)
  if (seconds < 5) return 'Updated just now'
  return seconds < 90 ? `Updated ${seconds}s ago` : `Updated ${Math.round(seconds / 60)} min ago`
}

/** `2 h` from `2 h ago`: the age column is narrow. */
function shortAge(iso: string, now: number): string {
  return relativeTime(iso, now).replace(/ ago$/, '').replace('just now', 'now')
}

function totals(view: ConductorView) {
  let running = 0
  let waiting = 0
  let outdated = 0
  for (const host of view.hosts) {
    for (const a of host.accounts) {
      for (const s of a.sessions) {
        if (s.running) running += 1
        if (s.running && s.waiting) waiting += 1
        if (s.running && s.updatePending) outdated += 1
      }
    }
  }
  return { running, waiting, outdated }
}

/** A word on a coloured ground: a count or a state. */
function Pill(ui: Ui, text: string, tone: Tone) {
  const { Text } = ui
  return (
    <Text backgroundColor={tone} color="inverseText" bold>
      {` ${text} `}
    </Text>
  )
}

/** The pane's own ⋯ menu, in the header. */
function paneMenu(act: Act): Array<MenuItem> {
  return [
    { value: 'refresh', label: 'Refresh', hotkey: 'r', run: act.refresh },
    {
      value: 'pair',
      label: 'Pair a host…',
      hotkey: 'p',
      run: () => act.openDialog({ kind: 'pair', code: '', label: '', error: null, isBusy: false }),
    },
    { value: 'settings', label: 'Settings…', hotkey: 's', run: act.openSettings },
  ]
}

function Header(ui: Ui, model: OverviewModel, act: Act) {
  const { Box, Text } = ui
  const { waiting } = totals(model.view)
  const offline = model.view.hosts.filter((known) => known.error).length
  return (
    <Box flexDirection="column">
      {/* Inset as far as a host card's border and padding, so this ⋯ lines up with the cards' own. */}
      <Box justifyContent="space-between" alignItems="center" paddingRight={ui.surface === 'terminal' ? 2 : 1}>
        <Box gap={1} flexShrink={1} minWidth={0} overflow="hidden" alignItems="center">
          {Icon(ui, 'claude', 'claude', 18)}
          <Text bold wrap="truncate-end">Remote Control CLI Servers</Text>
          {model.view.isDemo && Pill(ui, 'DEMO', 'permission')}
        </Box>
        {Menu(ui, 'pm', paneMenu(act), model, act)}
      </Box>
      <Text dimColor>
        {model.view.isLoading ? '◐ Reading your hosts…' : age(model.view.updatedAt, model.now)}
        {waiting > 0 && <Text color="warning"> · {waiting} waiting for you</Text>}
        {offline > 0 && <Text color="error"> · {count(offline, 'host')} offline</Text>}
      </Text>
      {model.note && NoteLine(ui, model.note, act)}
    </Box>
  )
}

function NoteLine(ui: Ui, note: ConductorNote, act: Act) {
  const { Box, Button, Text } = ui
  const look = {
    success: { glyph: '✓', tone: 'success' },
    error: { glyph: '✗', tone: 'error' },
    info: { glyph: 'i', tone: 'permission' },
  }[note.tone]
  return (
    <Box marginTop={1} borderStyle="round" borderColor={look.tone} paddingX={1} gap={1}>
      <Text color={look.tone} bold>
        {look.glyph}
      </Text>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        <Text bold>{note.text}</Text>
        {note.detail && <Text dimColor>{note.detail}</Text>}
      </Box>
      <Button key="note-dismiss" plain dimColor label="×" onPress={act.dismissNote} />
    </Box>
  )
}

/** How many running sessions on a host wait on a restart to update, and to what. */
function updatesOn(host: ConductorHost): { count: number; to: string | null } {
  const outdated = host.accounts.flatMap((a) => a.sessions).filter((s) => s.running && s.updatePending)
  return { count: outdated.length, to: outdated.find((s) => s.installedVersion)?.installedVersion ?? null }
}

/** One action in a ⋯ menu, with the letter that runs it while its menu has the keyboard. */
type MenuItem = { value: string; label: string; hotkey: string; run: () => void }

/**
 * A ⋯ button whose actions open in a small framed menu floating under it,
 * over the rows below rather than pushing them down: each action a button
 * with its letter, which presses it while the menu is open.
 */
function Menu(ui: Ui, key: string, items: Array<MenuItem>, model: OverviewModel, act: Act) {
  const { Box, Button } = ui
  const isOpen = model.openMenu === key
  return (
    <Box key={`mw-${key}`} position="relative" flexShrink={0}>
      <Button
        key={key}
        variant={isOpen ? 'primary' : undefined}
        label={isOpen ? '×' : '⋯'}
        onPress={() => act.toggleMenu(isOpen ? null : key)}
      />
      {isOpen && (
        <Box
          key={`menu-${key}`}
          position="absolute"
          top={1}
          right={0}
          flexDirection="column"
          borderStyle="round"
          borderColor="claude"
          backgroundColor="userMessageBackground"
          paddingX={1}
        >
          {items.map((item) => (
            <Button
              key={`mi-${key}-${item.value}`}
              plain
              hotkey={item.hotkey}
              label={item.label}
              onPress={() => {
                act.toggleMenu(null)
                item.run()
              }}
            />
          ))}
        </Box>
      )}
    </Box>
  )
}

/** A fixed slot for a mark, so the marks and menus line up down the column. */
function Slot(ui: Ui, mark: unknown) {
  const { Box } = ui
  return (
    <Box width={2} justifyContent="center">
      {mark as never}
    </Box>
  )
}

function hostMenu(host: ConductorHost, act: Act): Array<MenuItem> {
  return [
    {
      value: 'settings',
      label: 'Settings…',
      hotkey: 's',
      run: () =>
        act.openDialog({
          kind: 'host',
          hostId: host.id,
          label: host.label,
          suffix: host.info?.settings?.remoteControlSuffix ?? host.label,
          isSuffixOn: Boolean(host.info?.settings?.remoteControlSuffix),
          error: null,
          isBusy: false,
        }),
    },
    {
      value: 'newProfile',
      label: 'New profile…',
      hotkey: 'n',
      run: () => act.openDialog({ kind: 'newAccount', hostId: host.id, name: '', error: null, isBusy: false }),
    },
    {
      value: 'remove',
      label: 'Remove host…',
      hotkey: 'x',
      run: () => act.confirm({ kind: 'removeHost', hostId: host.id }),
    },
  ]
}

function HostSection(ui: Ui, host: ConductorHost, model: OverviewModel, act: Act) {
  const { Box, Text } = ui
  const isOnline = host.info !== null && host.error === null
  const updates = updatesOn(host)
  const versions = host.info
    ? [
        `Server ${host.info.serverVersion}`,
        host.info.claude ? `Claude ${claudeVersion(host.info.claude.version) ?? '?'}` : 'No Claude',
        host.info.tmux ? `tmux ${host.info.tmux.version.replace(/^tmux\s+/, '')}` : 'No tmux',
        host.address,
      ]
        .filter(Boolean)
        .join(' · ')
    : null
  return (
    <Box
      key={`host-${host.id}`}
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor="promptBorder"
      paddingX={1}
    >
      <Box key={`hb-${host.id}`} justifyContent="space-between" alignItems="center">
        <Box gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" alignItems="center">
          {Icon(ui, host.error ? 'offline' : 'host', host.error ? 'error' : isOnline ? 'success' : 'inactive', 16)}
          <Text bold>{host.label.toUpperCase()}</Text>
          {host.info?.settings?.remoteControlSuffix && <Text dimColor>({host.info.settings.remoteControlSuffix})</Text>}
        </Box>
        <Box gap={1} flexShrink={0} alignItems="center">
          {host.error && <Text color="error">Offline</Text>}
          {Menu(ui, `hm-${host.id}`, hostMenu(host, act), model, act)}
        </Box>
      </Box>
      <Box flexDirection="column">
        {versions && (
          <Text dimColor wrap="truncate-end">
            {versions}
          </Text>
        )}
        {updates.count > 0 && (
          <Box gap={1} alignItems="center">
            {Icon(ui, 'update', 'claude')}
            <Text color="claude" wrap="truncate-end">
              {count(updates.count, 'session')} can update{updates.to ? ` to ${updates.to}` : ''}
            </Text>
          </Box>
        )}
        {host.error && <Text color="error">{host.error}</Text>}
        {!host.error && host.accounts.length === 0 && host.info && <Text dimColor>No profiles yet.</Text>}
        {host.accounts.map((a) => AccountBlock(ui, host, a, model, act))}
      </Box>
    </Box>
  )
}

function accountMenu(host: ConductorHost, a: ConductorAccount, model: OverviewModel, act: Act): Array<MenuItem> {
  const name = a.account.name
  const running = a.sessions.filter((s) => s.running).length
  const outdated = a.sessions.filter((s) => s.running && s.updatePending).length
  const isArchivedShown = accountKey(host.id, name) in model.archived
  const items: Array<MenuItem | null> = [
    { value: 'newSession', label: 'New session…', hotkey: 'n', run: () => act.openNewSession(host.id, name) },
    Array.isArray(a.servers)
      ? {
          value: 'server',
          label: 'Remote Control server…',
          hotkey: 'e',
          run: () => act.openNewServer(host.id, name, null),
        }
      : null,
    a.account.signedIn
      ? { value: 'switch', label: 'Switch account…', hotkey: 's', run: () => act.openSignIn(host.id, name, true) }
      : { value: 'signIn', label: 'Sign in…', hotkey: 'i', run: () => act.openSignIn(host.id, name, false) },
    running > 1 || outdated > 0
      ? {
          value: 'restartAll',
          hotkey: 't',
          label: outdated ? `Restart all (${outdated} to update)…` : 'Restart all…',
          run: () => act.confirm({ kind: 'restartAll', hostId: host.id, account: name }),
        }
      : null,
    {
      value: 'archived',
      hotkey: 'a',
      label: isArchivedShown ? 'Hide Archived Sessions' : 'Archived Sessions',
      run: () => act.toggleArchived(host.id, name),
    },
    a.account.isDefault
      ? null
      : {
          value: 'rename',
          label: 'Rename…',
          hotkey: 'r',
          run: () =>
            act.openDialog({ kind: 'renameAccount', hostId: host.id, account: name, name, error: null, isBusy: false }),
        },
    a.account.isDefault
      ? null
      : {
          value: 'delete',
          label: 'Delete…',
          hotkey: 'd',
          run: () => act.confirm({ kind: 'deleteAccount', hostId: host.id, account: name }),
        },
  ]
  return items.filter((item): item is MenuItem => item !== null)
}

function AccountBlock(ui: Ui, host: ConductorHost, a: ConductorAccount, model: OverviewModel, act: Act) {
  const { Box, Button, Text } = ui
  const name = a.account.name
  const running = a.sessions.filter((s) => s.running)
  const previous = a.sessions.filter((s) => !s.running)
  const key = accountKey(host.id, name)
  const isAll = model.showAll.includes(key)
  const shown = isAll ? previous : previous.slice(0, PREVIOUS_SHOWN)
  const archived = model.archived[key]
  const left = shortLeft(a.account.signedInUntil, model.now)
  const email = a.account.account?.email ?? a.account.account?.name ?? null
  return (
    <Box key={`acct-${key}`} flexDirection="column" marginTop={1}>
      <Box
        key={`ab-${key}`}
        justifyContent="space-between"
        alignItems="center"
        paddingLeft={1}
        backgroundColor="userMessageBackground"
        hover={{ backgroundColor: 'userMessageBackgroundHover' }}
      >
        <Box gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" alignItems="center">
          {Icon(ui, 'claude', 'claude')}
          <Text bold>{name}</Text>
          {a.account.signedIn ? (
            <Text dimColor wrap="truncate-end">
              {[a.account.account?.plan, left && `${left} left`, email].filter(Boolean).join(' · ')}
            </Text>
          ) : (
            Pill(ui, 'Signed out', 'warning')
          )}
        </Box>
        <Box gap={1} flexShrink={0} alignItems="center">
          {Menu(ui, `am-${key}`, accountMenu(host, a, model, act), model, act)}
        </Box>
      </Box>
      {!a.account.signedIn && (
        <Text color="warning" wrap="wrap">
          {'  '}
          {a.account.pendingResume
            ? `Switching account: ${count(a.account.pendingResume, 'session')} ${a.account.pendingResume === 1 ? 'resumes' : 'resume'} here once it's signed in again.`
            : 'Sessions started here ask to sign in first.'}
        </Text>
      )}
      {a.error && <Text color="error"> {a.error}</Text>}
      {(a.servers?.length ?? 0) > 0 && (
        <Box flexDirection="column" marginTop={1} rowGap={ui.surface === 'desktop' ? 1 : 0}>
          {(a.servers ?? []).map((server) => ServerRow(ui, host, name, server, model, act))}
        </Box>
      )}
      {a.sessions.length === 0 && !a.error && <Text dimColor>{'    '}No sessions yet.</Text>}
      <Box flexDirection="column" marginTop={a.sessions.length ? 1 : 0} rowGap={ui.surface === 'desktop' ? 1 : 0}>
        {[...running, ...shown].map((s, i, all) => SessionRow(ui, host, name, s, i === all.length - 1, model, act))}
      </Box>
      {previous.length > PREVIOUS_SHOWN && (
        <Box marginLeft={4}>
          <Button
            key={`all-${key}`}
            plain
            dimColor
            label={isAll ? 'Show fewer' : `Show all ${previous.length}`}
            onPress={() => act.toggleShowAll(host.id, name)}
          />
        </Box>
      )}
      {archived && ArchivedList(ui, host, name, archived, model, act)}
    </Box>
  )
}

/** Small marks after a title: Remote Control connected, an update waiting on a restart. */
function Marks(ui: Ui, session: RemoteSession) {
  const { Box, Text } = ui
  return (
    <Box gap={1} alignItems="center">
      {session.running && session.waiting && <Text color="warning">Waiting for you</Text>}
      {session.running && session.remoteControlConnecting && !session.bridgeSessionId && (
        <Text color="suggestion">Connecting…</Text>
      )}
      {Slot(
        ui,
        session.running && session.remoteControl && session.bridgeSessionId && Icon(ui, 'remote', 'permission'),
      )}
      {Slot(ui, session.running && session.updatePending && Icon(ui, 'update', 'claude'))}
    </Box>
  )
}

/** The Remote Control server running in `folder`, if any. */
function serverIn(servers: Array<RcServer> | null | undefined, folder: string | null): RcServer | undefined {
  return folder ? servers?.find((server) => server.folder === folder) : undefined
}

function sessionMenu(
  host: ConductorHost,
  target: ConductorTarget,
  session: RemoteSession,
  servers: Array<RcServer> | null | undefined,
  act: Act,
): Array<MenuItem> {
  const windowId = session.window?.windowId ?? ''
  const inServerWindow = Boolean(session.window && host.info?.tmux && session.window.session === host.info.tmux.session)
  const items: Array<MenuItem | null> = [
    session.running && session.waiting && session.window
      ? { value: 'answer', label: 'Answer…', hotkey: 'a', run: () => act.openWindow(target, windowId) }
      : null,
    session.running ? null : { value: 'resume', label: 'Resume', hotkey: 'u', run: () => act.resume(target) },
    session.running && session.bridgeSessionId
      ? {
          value: 'app',
          label: 'Open in Claude app',
          hotkey: 'c',
          run: () => act.openClaudeApp(target, session.bridgeSessionId ?? ''),
        }
      : null,
    session.running && session.bridgeSessionId
      ? {
          value: 'open',
          label: 'Open on claude.ai',
          hotkey: 'o',
          run: () => act.openClaude(target, session.bridgeSessionId ?? ''),
        }
      : null,
    session.running && inServerWindow && !session.waiting
      ? { value: 'window', label: 'Tmux Window…', hotkey: 'w', run: () => act.openWindow(target, windowId) }
      : null,
    // A served session comes back with its server, not on its own.
    session.running && !session.served
      ? {
          value: 'restart',
          hotkey: 't',
          label: session.updatePending ? `Restart to update (${updateVersions(session)})` : 'Restart',
          run: () => act.restart(target),
        }
      : null,
    session.running
      ? { value: 'stop', label: 'Stop…', hotkey: 's', run: () => act.confirm({ kind: 'stop', target }) }
      : null,
    {
      value: 'rename',
      label: 'Rename…',
      hotkey: 'n',
      run: () =>
        act.openDialog({
          kind: 'renameSession',
          target,
          name: session.named ? (session.title ?? '') : '',
          running: session.running,
          error: null,
          isBusy: false,
        }),
    },
    { value: 'move', label: 'Move to another profile…', hotkey: 'm', run: () => act.openMove(target) },
    session.running
      ? null
      : { value: 'archive', label: 'Archive…', hotkey: 'v', run: () => act.confirm({ kind: 'archive', target }) },
    Array.isArray(servers) && session.cwd && !serverIn(servers, session.cwd)
      ? {
          value: 'server',
          label: 'Remote Control server here…',
          hotkey: 'e',
          run: () => act.openNewServer(target.hostId, target.account, session.cwd),
        }
      : null,
  ]
  return items.filter((item): item is MenuItem => item !== null)
}

function serverMenu(host: ConductorHost, account: string, server: RcServer, act: Act): Array<MenuItem> {
  const title = server.name ?? folderName(server.folder)
  const target: ConductorTarget = { hostId: host.id, account, sessionId: '', title }
  const items: Array<MenuItem | null> = [
    server.window
      ? {
          value: 'window',
          label: server.attention ? 'Answer…' : 'Tmux Window…',
          hotkey: server.attention ? 'a' : 'w',
          run: () => act.openWindow(target, server.window?.windowId ?? ''),
        }
      : null,
    server.environmentUrl
      ? {
          value: 'open',
          label: 'Open on claude.ai',
          hotkey: 'o',
          run: () => act.openEnvironment(host.id, server.environmentUrl ?? ''),
        }
      : null,
    server.window
      ? {
          value: 'stop',
          label: 'Stop…',
          hotkey: 's',
          run: () =>
            act.confirm({
              kind: 'stopServer',
              hostId: host.id,
              account,
              pid: server.pid,
              folder: server.folder,
              sessions: server.sessions,
            }),
        }
      : null,
  ]
  return items.filter((item): item is MenuItem => item !== null)
}

/** A Remote Control server: the folder the Claude apps can start sessions in, and how. */
function ServerRow(ui: Ui, host: ConductorHost, account: string, server: RcServer, model: OverviewModel, act: Act) {
  const { Box, Text } = ui
  const isTerminal = ui.surface === 'terminal'
  const title = server.name ?? folderName(server.folder)
  const detail = [
    shortenHome(server.folder, host.info?.home ?? null),
    server.spawn === 'worktree' ? 'a worktree per session' : 'sessions in this folder',
    count(server.sessions, 'session'),
    server.window ? null : 'started elsewhere',
  ]
    .filter(Boolean)
    .join(' · ')
  const items = serverMenu(host, account, server, act)
  return (
    <Box
      key={`rc-${server.pid}`}
      justifyContent="space-between"
      alignItems="center"
      paddingLeft={isTerminal ? 1 : 3}
      hover={{ backgroundColor: 'userMessageBackgroundHover' }}
    >
      <Box gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" alignItems="center">
        {Icon(ui, 'remote', server.attention ? 'warning' : 'permission')}
        <Text wrap="truncate-end">
          <Text bold>Remote Control</Text> {title}
          <Text dimColor> · {detail}</Text>
        </Text>
      </Box>
      <Box gap={1} flexShrink={0} alignItems="center">
        {server.attention && <Text color="warning">Waiting for you</Text>}
        {items.length > 0 && Menu(ui, `rm-${server.pid}`, items, model, act)}
      </Box>
    </Box>
  )
}

function SessionRow(
  ui: Ui,
  host: ConductorHost,
  account: string,
  session: RemoteSession,
  isLast: boolean,
  model: OverviewModel,
  act: Act,
) {
  const { Box, Text } = ui
  const state = sessionState(session)
  const title = sessionTitle(session)
  const target: ConductorTarget = { hostId: host.id, account, sessionId: session.id, title }
  const isBusy = model.busy?.startsWith(`${host.id}/${account}/${session.id}:`) ?? false
  const when = shortAge(session.updatedAt, model.now)
  // Tree lines only where text is monospaced: the desktop's proportional font can't line them up.
  const isTerminal = ui.surface === 'terminal'
  const branch = isTerminal ? <Text color="promptBorder">{isLast ? '└─' : '├─'}</Text> : null
  const glyph = isBusy ? <Text color="claude">…</Text> : Icon(ui, state.icon, state.tone)
  const servers = host.accounts.find((a) => a.account.name === account)?.servers
  const items = sessionMenu(host, target, session, servers, act)
  return (
    <Box
      key={`s-${session.id}`}
      justifyContent="space-between"
      alignItems="center"
      paddingLeft={isTerminal ? 1 : 3}
      hover={{ backgroundColor: 'userMessageBackgroundHover' }}
    >
      <Box gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" alignItems="center">
        {branch}
        {glyph}
        <Text wrap="truncate-end">
          {title}
          <Text dimColor> · {when}</Text>
        </Text>
      </Box>
      <Box gap={1} flexShrink={0} alignItems="center">
        {Marks(ui, session)}
        {Menu(ui, `sm-${session.id}`, items, model, act)}
      </Box>
    </Box>
  )
}

function ArchivedList(
  ui: Ui,
  host: ConductorHost,
  account: string,
  list: Array<ArchivedSession>,
  model: OverviewModel,
  act: Act,
) {
  const { Box, Button, Text } = ui
  const total = list.reduce((sum, a) => sum + (a.sizeBytes ?? 0), 0)
  return (
    <Box
      flexDirection="column"
      marginLeft={2}
      marginTop={1}
      borderStyle="round"
      borderColor="promptBorder"
      paddingX={1}
    >
      <Box justifyContent="space-between" alignItems="center">
        <Text bold>
          Archived Sessions{' '}
          <Text dimColor>
            · {count(list.length, 'session')} · {formatBytes(total)}
          </Text>
        </Text>
        <Button
          key={`archived-close-${account}`}
          plain
          dimColor
          label="×"
          onPress={() => act.toggleArchived(host.id, account)}
        />
      </Box>
      {list.length === 0 && <Text dimColor>Nothing archived.</Text>}
      {list.map((a) => (
        <Box key={`ar-${a.id}-${a.archive}`} flexDirection="column" marginTop={1}>
          <Box justifyContent="space-between">
            <Text wrap="truncate-end">{a.title ?? a.id.slice(0, 8)}</Text>
            <Box columnGap={2}>
              <Button
                key={`restore-${a.id}-${a.archive}`}
                plain
                label="Restore"
                onPress={() => act.restore(host.id, account, a)}
              />
              <Button
                key={`delarch-${a.id}-${a.archive}`}
                plain
                dimColor
                label="Delete"
                onPress={() =>
                  act.confirm({
                    kind: 'deleteArchive',
                    hostId: host.id,
                    account,
                    id: a.id,
                    archive: a.archive,
                    title: a.title ?? a.id.slice(0, 8),
                  })
                }
              />
            </Box>
          </Box>
          <Text dimColor wrap="truncate-end">
            {formatBytes(a.sizeBytes ?? 0)} · {shortenHome(a.cwd, host.info?.home)} ·{' '}
            {relativeTime(stampToIso(a.stamp), model.now)}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function Legend(ui: Ui, icon: IconName, tone: Tone, label: string) {
  const { Box, Text } = ui
  return (
    <Box key={`legend-${icon}`} gap={1} alignItems="center">
      {Icon(ui, icon, tone, 12)}
      <Text dimColor>{label}</Text>
    </Box>
  )
}

/** The whole main pane. */
export function Overview(ui: Ui, model: OverviewModel, act: Act) {
  const { Box, Text } = ui
  return (
    <Box flexDirection="column">
      {Header(ui, model, act)}
      {model.view.hosts.length === 0 && !model.view.isLoading && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="claude" paddingX={1}>
          <Text bold>No hosts yet</Text>
          <Text dimColor>
            Install remote-control-conductor-server on a Linux machine where Claude Code runs and run its setup. Then
            choose Pair a host in the ⋯ menu above, and paste the code it prints.
          </Text>
        </Box>
      )}
      {model.view.hosts.map((host) => HostSection(ui, host, model, act))}
      {model.view.hosts.length > 0 && (
        <Box marginTop={1} columnGap={2} flexWrap="wrap">
          {Legend(ui, 'running', 'success', 'Running')}
          {Legend(ui, 'waiting', 'warning', 'Waiting')}
          {Legend(ui, 'stopped', 'inactive', 'Stopped')}
          {Legend(ui, 'remote', 'permission', 'Remote Control')}
          {Legend(ui, 'update', 'claude', 'Update')}
          <Text dimColor>⋯ opens a row's actions</Text>
        </Box>
      )}
    </Box>
  )
}
