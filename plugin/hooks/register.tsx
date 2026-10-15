// Remote Control CLI Servers: the hosts it paired with, their
// Claude accounts and sessions, in a pane beside the conversation; dialogs
// for everything the Mac app does with them; and tools for Claude.
//
// Everything that calls `$` lives in this file (the engine reads its calls
// off the source); the views and pure helpers are in views/ and lib/.

import type { EngineInterface, Register } from 'claude-code'
import type {
  ArchivedSession,
  ConductorAccount,
  ConductorConfirmAction,
  ConductorDialog,
  ConductorHost,
  ConductorNote,
  ConductorSelection,
  ConductorTarget,
  ConductorView,
  DirListing,
  HostInfo,
  HostSettings,
  LaunchResult,
  LoginStart,
  LogoutResult,
  MoveProgress,
  PairResponse,
  RcServer,
  RemoteAccount,
  RemoteSession,
  RenameSessionResult,
  StartRcServerResult,
  TransferPlan,
  TransferReport,
  WindowKey,
  WindowScreen,
} from '../types'
import type { Act, DialogAct, Ui } from './views/act'

import { atom, read, update } from 'claude-code'

import {
  errorCode,
  errorText,
  RemoteError,
  readCurl,
} from './lib/curl'
import { bandModel } from './lib/band'
import { demoAnswer, demoHosts, isDemoHost } from './lib/demo'
import { count, folderName, formatBytes, sessionTitle } from './lib/format'
import { addressOrder, findHost, mergeHosts, type PairedHost, parseHostList } from './lib/hosts'
import { liveEdit, mergeKeys, trimScreen } from './lib/keys'
import { MAC_APP_BINARY, mcpCall, mcpResult, openedWhere } from './lib/mac-app'
import { type Afterwards, isRunning, memoryDecisions, progressId } from './lib/move'
import { decodePairingCode } from './lib/pairing'
import { findSession, isFound, splitProfile } from './lib/refs'
import { ARCHIVE_BODY, movedDetails, signOutBody, stopBody } from './lib/texts'
import { sessionJson, TOOL_SPECS, toolDecisions } from './lib/tools'
import { Dialog, dialogRows, dialogTitle, windowRegionProps } from './views/dialogs'
import { Band } from './views/band'
import { Overview } from './views/overview'

type Engine = EngineInterface

const PANE = 'conductor-hosts'
const DIALOG = 'conductor-dialog'
/** How often the pane looks: every tick while a session connects, else every REFRESH_MS. */
const TICK_MS = 3_000
const REFRESH_MS = 15_000
/** How often the band above the prompt reads the hosts while the pane is closed. */
const BAND_REFRESH_MS = 30_000
const NOTE_MS = 20_000

const SIGN_IN_HOSTS = ['claude.com', 'claude.ai', 'platform.claude.com', 'console.anthropic.com']

const view = atom(
  { plugin: 'remote-control-cli-servers', key: 'view' } as const,
  {
    isLoading: false,
    hosts: [],
    updatedAt: null,
  } as ConductorView,
)
const selected = atom({ plugin: 'remote-control-cli-servers', key: 'selected' } as const, null as ConductorSelection | null)
const archived = atom({ plugin: 'remote-control-cli-servers', key: 'archived' } as const, {} as Record<string, Array<ArchivedSession>>)
const showAll = atom({ plugin: 'remote-control-cli-servers', key: 'showAll' } as const, [] as Array<string>)
const busy = atom({ plugin: 'remote-control-cli-servers', key: 'busy' } as const, null as string | null)
const note = atom({ plugin: 'remote-control-cli-servers', key: 'note' } as const, null as ConductorNote | null)
const dialog = atom({ plugin: 'remote-control-cli-servers', key: 'dialog' } as const, null as ConductorDialog | null)
const openMenu = atom({ plugin: 'remote-control-cli-servers', key: 'openMenu' } as const, null as string | null)
const bandOn = atom({ plugin: 'remote-control-cli-servers', key: 'bandOn' } as const, true as boolean)
const paneOpen = atom({ plugin: 'remote-control-cli-servers', key: 'paneOpen' } as const, false as boolean)

let refreshing: Promise<void> | null = null
let lastRefreshAt = 0
let ticker: { cancel: () => void } | null = null
let windowTimer: { cancel: () => void } | null = null
let moveTimer: { cancel: () => void } | null = null
/** The last key typed into the window's region that was sent, and the sends in order. */
let typedUpTo = 0
let typing: Promise<void> = Promise.resolve()
/** The address each host last answered on, this session. */
const answeredOn = new Map<string, string>()

// ── Hosts, pins and requests ──

type Pins = Record<string, { fingerprint: string; key: string }>

/** How long a script may run: its own curl limit, and room to read the Keychain. */
const scriptTimeout = (seconds: number) => ({ timeoutMs: (seconds + 15) * 1000 })

/** The hosts: the plugin's own list, and any the Mac app paired that it hasn't seen. */
/** Whether demo mode (`/remote-control-cli-servers demo`) is on: made-up hosts, for screenshots. */
async function isDemo($: Engine): Promise<boolean> {
  return (await $.store.get('demo')) === true
}

/** Opens a link in the browser, except for a demo host's, where nothing is real. */
async function openUrl($: Engine, url: string, hostId: string) {
  if (isDemoHost(hostId)) return { exitCode: 0, stderr: '' }
  return $.process.run(['/usr/bin/open', url])
}

async function pairedHosts($: Engine): Promise<Array<PairedHost>> {
  if (await isDemo($)) return demoHosts(await $.clock.now())
  const mine = ((await $.store.get('hosts')) ?? []) as Array<PairedHost>
  const removed = ((await $.store.get('removedHosts')) ?? []) as Array<string>
  let app: Array<PairedHost> = []
  try {
    const home = await $.env.get('HOME')
    app = parseHostList(await $.fs.read(`${home}/Library/Application Support/ai-profiles/remote-hosts.json`))
  } catch {
    // No Mac app, or nothing paired there.
  }
  const merged = mergeHosts(mine, app, removed)
  if (merged.length !== mine.length) await $.store.set('hosts', merged)
  return merged
}

async function hostById($: Engine, hostId: string): Promise<PairedHost> {
  const host = (await pairedHosts($)).find((known) => known.id === hostId)
  if (!host) throw new RemoteError('not_paired', 'That host is no longer paired.')
  return host
}

async function saveHost($: Engine, host: PairedHost) {
  const list = ((await $.store.get('hosts')) ?? []) as Array<PairedHost>
  const at = list.findIndex((known) => known.id === host.id)
  await $.store.set('hosts', at < 0 ? [...list, host] : list.map((known) => (known.id === host.id ? host : known)))
  const removed = ((await $.store.get('removedHosts')) ?? []) as Array<string>
  if (removed.includes(host.id))
    await $.store.set(
      'removedHosts',
      removed.filter((id) => id !== host.id),
    )
}

/** The pinned key of the certificate at `address`, checked against the pairing; `null` when it doesn't answer. */
async function pinFor(
  $: Engine,
  host: Pick<PairedHost, 'id' | 'fingerprint'>,
  address: string,
): Promise<string | null> {
  const pins = ((await $.store.get('pins')) ?? {}) as Pins
  const known = pins[host.id]
  if (known && known.fingerprint === host.fingerprint) return known.key
  const run = await $.process.run(
    ['/bin/sh', `${$.plugin.root}/scripts/pin.sh`, address, host.fingerprint],
    scriptTimeout(15),
  )
  if (run.exitCode === 7) return null
  if (run.exitCode === 90) throw new RemoteError('cert_mismatch', "The host's certificate doesn't match the pairing.")
  if (run.exitCode !== 0) throw new RemoteError('client', run.stderr.trim() || 'The certificate could not be read.')
  const key = run.stdout.trim()
  await $.store.set('pins', { ...pins, [host.id]: { fingerprint: host.fingerprint, key } })
  return key
}

/** One request to a host, trying its addresses (the last good one first). */
async function call(
  $: Engine,
  host: PairedHost,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  seconds = 30,
): Promise<unknown> {
  if (isDemoHost(host.id)) return demoAnswer(host.id, method, path, body, await $.clock.now())
  for (const address of addressOrder({ ...host, lastGoodAddress: answeredOn.get(host.id) ?? host.lastGoodAddress })) {
    const key = await pinFor($, host, address)
    if (!key) continue
    const json = body === undefined ? '' : JSON.stringify(body)
    const run = await $.process.run(
      ['/bin/sh', `${$.plugin.root}/scripts/request.sh`, host.id, key, `https://${address}${path}`, method, json, String(seconds)],
      scriptTimeout(seconds),
    )
    const answer = readCurl(run, method === 'GET')
    if (answer === null) continue
    if (answeredOn.get(host.id) !== address) {
      answeredOn.set(host.id, address)
      if (host.lastGoodAddress !== address) await saveHost($, { ...host, lastGoodAddress: address })
    }
    return answer
  }
  throw new RemoteError('offline', `${host.label} isn't answering.`)
}

/** `call` by host id. */
async function callHost(
  $: Engine,
  hostId: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  seconds = 30,
) {
  return call($, await hostById($, hostId), method, path, body, seconds)
}

const enc = encodeURIComponent
const sessionPath = (account: string, sessionId: string, action: string) =>
  `/v1/accounts/${enc(account)}/sessions/${enc(sessionId)}/${action}`

// ── Reading ──

/** An account's Remote Control servers, or null from a server too old to have them. */
async function readServers($: Engine, host: PairedHost, account: string): Promise<Array<RcServer> | null> {
  try {
    return (await call($, host, 'GET', `/v1/accounts/${enc(account)}/rc-servers`)) as Array<RcServer>
  } catch (err) {
    if (errorCode(err) === 'http_404') return null
    throw err
  }
}

async function readHost($: Engine, host: PairedHost): Promise<ConductorHost> {
  const base = { id: host.id, label: host.label, hostname: host.hostname, address: null, info: null, accounts: [] }
  try {
    const info = (await call($, host, 'GET', '/v1/info')) as HostInfo
    const accounts = (await call($, host, 'GET', '/v1/accounts')) as Array<RemoteAccount>
    const withSessions: Array<ConductorAccount> = await Promise.all(
      accounts.map(async (account) => {
        try {
          const sessions = (await call(
            $,
            host,
            'GET',
            `/v1/accounts/${enc(account.name)}/sessions`,
          )) as Array<RemoteSession>
          return { account, sessions, servers: await readServers($, host, account.name), error: null }
        } catch (err) {
          return { account, sessions: [], error: errorText(err, `Could not read ${host.label}'s sessions.`) }
        }
      }),
    )
    return { ...base, address: answeredOn.get(host.id) ?? null, info, accounts: withSessions, error: null }
  } catch (err) {
    return { ...base, error: errorText(err, 'Not answering.') }
  }
}

/** Reads every host again; one refresh at a time. */
function refresh($: Engine): Promise<void> {
  refreshing ??= (async () => {
    await update($, view, (current) => ({ ...current, isLoading: true }))
    try {
      const hosts = await Promise.all((await pairedHosts($)).map((host) => readHost($, host)))
      lastRefreshAt = await $.clock.now()
      const demo = await isDemo($)
      await update($, view, () => ({ isLoading: false, hosts, updatedAt: lastRefreshAt, isDemo: demo }))
      const shown = await read($, archived)
      for (const key of Object.keys(shown)) void loadArchived($, key)
      const waiting = hosts
        .flatMap((known) => known.accounts.flatMap((a) => a.sessions))
        .filter((s) => s.running && s.waiting).length
      // The band says it already; without the band, the status line does.
      const isBandOn = await read($, bandOn)
      $.ui.status(!isBandOn && waiting ? `◐ ${count(waiting, 'host session')} waiting for you` : undefined)
    } catch (err) {
      await update($, view, (current) => ({ ...current, isLoading: false }))
      await setNote($, { tone: 'error', text: errorText(err) })
    }
  })().finally(() => {
    refreshing = null
  })
  return refreshing
}

async function loadArchived($: Engine, key: string) {
  const [hostId = '', account = ''] = key.split('/')
  try {
    const list = (await callHost($, hostId, 'GET', `/v1/accounts/${enc(account)}/archived`)) as Array<ArchivedSession>
    await update($, archived, (all) => (key in all ? { ...all, [key]: list } : all))
  } catch (err) {
    await setNote($, { tone: 'error', text: errorText(err, 'Could not read the archived sessions.') })
  }
}

/**
 * With the pane open: every TICK_MS while a session connects, else every REFRESH_MS. With it closed,
 * every BAND_REFRESH_MS for the band, or not at all when the band is off.
 */
async function tick($: Engine) {
  const isPaneOpen = (await $.ui.panes()).some((pane) => pane.id === PANE)
  // Kept in step with the store (another session may have turned the band off) and the panes.
  const isBandOn = (await $.store.get('band')) !== false
  if ((await read($, bandOn)) !== isBandOn) await update($, bandOn, () => isBandOn)
  if ((await read($, paneOpen)) !== isPaneOpen) await update($, paneOpen, () => isPaneOpen)
  if (!isPaneOpen && !isBandOn) return
  const now = await $.clock.now()
  const current = await read($, view)
  const isConnecting = current.hosts.some((known) =>
    known.accounts.some((a) => a.sessions.some((s) => s.remoteControlConnecting)),
  )
  const every = isPaneOpen ? REFRESH_MS : BAND_REFRESH_MS
  if ((isPaneOpen && isConnecting) || now - lastRefreshAt >= every) void refresh($)
}

// ── Notes and actions ──

async function setNote($: Engine, value: ConductorNote | null) {
  await update($, note, () => value)
  if (value && value.tone !== 'error') {
    $.clock.after(
      NOTE_MS,
      () => void update($, note, (held) => (held === value || held?.text === value.text ? null : held)),
    )
  }
}

/** Runs one action at a time, its note shown when it's done, then reads the hosts again. */
async function perform($: Engine, token: string, work: () => Promise<ConductorNote | null>) {
  if (await read($, busy)) {
    await setNote($, { tone: 'info', text: 'One thing at a time: wait for the last action to finish.' })
    return
  }
  await update($, busy, () => token)
  try {
    const result = await work()
    if (result) await setNote($, result)
  } catch (err) {
    await setNote($, { tone: 'error', text: errorText(err) })
  } finally {
    await update($, busy, () => null)
  }
  void refresh($)
}

const targetKey = (t: ConductorTarget) => `${t.hostId}/${t.account}/${t.sessionId}`

async function hostLabel($: Engine, hostId: string) {
  return (await read($, view)).hosts.find((known) => known.id === hostId)?.label ?? 'the host'
}

/** After a resume, restart or start: the window when Claude is asking something, else a note. */
async function afterLaunch(
  $: Engine,
  target: ConductorTarget,
  launch: LaunchResult,
  done: ConductorNote,
): Promise<ConductorNote | null> {
  if (launch.attention) {
    await openWindowDialog($, target, launch.window.windowId, launch)
    return null
  }
  if (launch.alreadyRunning)
    return { tone: 'info', text: 'Already running', detail: 'It was open there already, so nothing new was started.' }
  return done
}

async function resume($: Engine, t: ConductorTarget) {
  await perform($, `${targetKey(t)}:resume`, async () => {
    const launch = (await callHost(
      $,
      t.hostId,
      'POST',
      sessionPath(t.account, t.sessionId, 'resume'),
      { trustFolder: true },
      45,
    )) as LaunchResult
    const label = await hostLabel($, t.hostId)
    return afterLaunch($, t, launch, {
      tone: 'success',
      text: `Resumed ${t.title} on ${label}`,
      detail: `In tmux window ${launch.window.windowId}, with Remote Control on.`,
    })
  })
}

async function restart($: Engine, t: ConductorTarget) {
  await perform($, `${targetKey(t)}:restart`, async () => {
    const launch = (await callHost(
      $,
      t.hostId,
      'POST',
      sessionPath(t.account, t.sessionId, 'restart'),
      { trustFolder: true },
      60,
    )) as LaunchResult
    const label = await hostLabel($, t.hostId)
    return afterLaunch($, t, launch, {
      tone: 'success',
      text: `Restarted ${t.title} on ${label}`,
      detail: `In tmux window ${launch.window.windowId}, on the host's current claude.`,
    })
  })
}

async function openOnClaude($: Engine, t: ConductorTarget, bridgeSessionId: string) {
  await perform($, `${targetKey(t)}:open`, async () => {
    const url = `https://claude.ai/code/${bridgeSessionId}`
    const run = await openUrl($, url, t.hostId)
    if (run.exitCode !== 0) throw new Error(run.stderr.trim() || 'Could not open it.')
    return { tone: 'success', text: `Opened ${t.title} on claude.ai` }
  })
}

/**
 * Opens a host session in the Claude desktop app. The Mac app, when it's
 * installed, knows which Claude app on this Mac is signed in as the session's
 * account (it asks the profile's own app, starting it if needed); without it,
 * the link goes to the default Claude app.
 */
async function openInClaudeApp($: Engine, t: ConductorTarget, bridgeSessionId: string) {
  await perform($, `${targetKey(t)}:app`, async () => {
    if (isDemoHost(t.hostId)) return { tone: 'info', text: `Demo mode: ${t.title} would open in the Claude app` }
    const hasMacApp = await $.fs.stat(MAC_APP_BINARY).then(
      () => true,
      () => false,
    )
    if (hasMacApp) {
      const host = await hostById($, t.hostId)
      const run = await $.process.run(
        [
          '/usr/bin/env',
          '-u',
          'CLAUDE_CONFIG_DIR',
          '/Applications/Remote Control Conductor.app/Contents/MacOS/remote-control-conductor',
          'mcp',
        ],
        {
          stdin: mcpCall('open_in_claude', { profile: `${host.hostname}/${t.account}`, session: t.sessionId }),
          timeoutMs: 90_000,
        },
      )
      const result = mcpResult(run.stdout)
      if (result && !result.isError) {
        const { app, note } = openedWhere(result.text)
        return app && app !== 'claude.ai'
          ? { tone: 'success', text: `Opened ${t.title} in ${app}` }
          : {
              tone: 'info',
              text: `Opened ${t.title} on claude.ai`,
              detail: note ?? 'No Claude app on this Mac is signed in as its account.',
            }
      }
      if (result?.isError) throw new Error(result.text)
    }
    const run = await $.process.run(['/usr/bin/open', `claude://code/${bridgeSessionId}`])
    if (run.exitCode !== 0) throw new Error(run.stderr.trim() || 'Could not open the Claude app.')
    return { tone: 'success', text: `Opened ${t.title} in the Claude app` }
  })
}

async function restore($: Engine, hostId: string, account: string, a: ArchivedSession) {
  const title = a.title ?? a.id.slice(0, 8)
  await perform($, `${hostId}/${account}/${a.id}:restore`, async () => {
    await callHost(
      $,
      hostId,
      'POST',
      `/v1/accounts/${enc(account)}/archived/${enc(a.id)}/${enc(a.archive)}/restore`,
      {},
    )
    await loadArchived($, `${hostId}/${account}`)
    return { tone: 'success', text: 'Restored', detail: title }
  })
}

// ── Confirmations ──

async function confirmDialog($: Engine, action: ConductorConfirmAction): Promise<ConductorDialog> {
  const current = await read($, view)
  const host = current.hosts.find((known) => known.id === ('target' in action ? action.target.hostId : action.hostId))
  const label = host?.label ?? 'the host'
  const base = { kind: 'confirm' as const, action, error: null, isBusy: false }
  switch (action.kind) {
    case 'stopServer':
      return {
        ...base,
        title: 'Stop this Remote Control server?',
        body: `${action.folder}\n\nThe Claude apps can no longer start sessions in this folder${
          action.sessions ? `, and the ${count(action.sessions, 'session')} it serves stop answering` : ''
        }. Starting a server here again within a few hours brings them back.`,
        confirmLabel: 'Stop',
        isDanger: true,
      }
    case 'restartServer':
      return {
        ...base,
        title: 'Restart this Remote Control server to update?',
        body: `${action.folder}\n\nClaude Code ${action.versions}.${
          action.sessions
            ? ` The ${count(action.sessions, 'session')} it serves stop answering for a moment and come back with it.`
            : ''
        }`,
        confirmLabel: 'Restart',
        isDanger: false,
      }
    case 'stop': {
      const session = host?.accounts
        .find((a) => a.account.name === action.target.account)
        ?.sessions.find((s) => s.id === action.target.sessionId)
      return {
        ...base,
        title: 'Stop this session?',
        body: `${action.target.title}\n\n${stopBody(Boolean(session?.empty))}`,
        confirmLabel: 'Stop',
        isDanger: true,
      }
    }
    case 'archive':
      return {
        ...base,
        title: 'Archive this session?',
        body: `${action.target.title}\n\n${ARCHIVE_BODY}`,
        confirmLabel: 'Archive',
        isDanger: false,
      }
    case 'deleteArchive': {
      const list = (await read($, archived))[`${action.hostId}/${action.account}`] ?? []
      const size = formatBytes(list.find((a) => a.id === action.id && a.archive === action.archive)?.sizeBytes ?? 0)
      return {
        ...base,
        title: 'Delete this archive?',
        body: `${action.title}\n\nThe archived transcript goes for good, and the session can't be restored. ${label} gets back ${size}.`,
        confirmLabel: `Delete, freeing ${size}`,
        isDanger: true,
      }
    }
    case 'restartAll': {
      const running =
        host?.accounts.find((a) => a.account.name === action.account)?.sessions.filter((s) => s.running).length ?? 0
      return {
        ...base,
        title: `Restart ${count(running, 'running session')}?`,
        body: `On ${label}, in ${action.account}. Each one stops and starts again on the host's current claude, one after another, keeping its conversation. Anything they are in the middle of stops.`,
        confirmLabel: 'Restart all',
        isDanger: false,
      }
    }
    case 'restartServers': {
      const servers = (host?.accounts.find((a) => a.account.name === action.account)?.servers ?? []).filter(
        (server) => server.window,
      )
      return {
        ...base,
        title: `Restart ${count(servers.length, 'Remote Control server')}?`,
        body: `On ${label}, in ${action.account}. Each one starts again on the Claude Code installed now, one after another. The sessions they serve stop answering for a moment and come back with them.`,
        confirmLabel: 'Restart all',
        isDanger: false,
      }
    }
    case 'signOut':
      return {
        ...base,
        title: `Sign out ${action.account}?`,
        body: signOutBody(action.running),
        confirmLabel: action.running > 0 ? 'Stop sessions and sign out' : 'Sign out',
        isDanger: true,
      }
    case 'deleteAccount':
      return {
        ...base,
        title: `Delete ${action.account}?`,
        body: `On ${label}. Its folder, with its sign-in and all its sessions, moves to .trash next to it. Nothing is erased: move it back to have the account again. The host refuses while a session runs or a sign-in is under way.`,
        confirmLabel: 'Delete',
        isDanger: true,
      }
    case 'removeHost':
      return {
        ...base,
        title: `Remove ${label}?`,
        body: 'Forgets this host and deletes its token from the Keychain (the Mac app loses it too). The server is told to forget this Mac, if it can be reached. Nothing on the host changes. To see it again later, pair it with a new code.',
        confirmLabel: 'Remove',
        isDanger: true,
      }
  }
}

/**
 * Stop a Remote Control server and start it again in its folder, with its
 * name and spawn mode, on the Claude Code installed now. The sessions it
 * serves come back with it.
 */
async function restartRcServer(
  $: Engine,
  hostId: string,
  account: string,
  server: { pid: number; folder: string; name: string | null; spawn: string },
): Promise<StartRcServerResult> {
  const base = `/v1/accounts/${enc(account)}/rc-servers`
  await callHost($, hostId, 'POST', `${base}/${server.pid}/stop`, {})
  return (await callHost(
    $,
    hostId,
    'POST',
    base,
    { folder: server.folder, ...(server.name ? { name: server.name } : {}), spawn: server.spawn, trustFolder: false },
    45,
  )) as StartRcServerResult
}

/** Does what a confirm dialog confirmed; the note to show after. */
async function runConfirmed($: Engine, action: ConductorConfirmAction): Promise<ConductorNote> {
  switch (action.kind) {
    case 'stopServer': {
      await callHost($, action.hostId, 'POST', `/v1/accounts/${enc(action.account)}/rc-servers/${action.pid}/stop`, {})
      return { tone: 'success', text: 'Stopped the Remote Control server', detail: action.folder }
    }
    case 'restartServer': {
      const started = await restartRcServer($, action.hostId, action.account, action)
      return started.server.attention
        ? { tone: 'info', text: 'Restarted; the server is waiting for you in its window', detail: started.server.attention.text }
        : { tone: 'success', text: `Restarted on Claude Code ${action.versions.split(' → ')[1] ?? ''}`.trim(), detail: action.folder }
    }
    case 'restartServers': {
      const current = await read($, view)
      const host = current.hosts.find((known) => known.id === action.hostId)
      const servers = (host?.accounts.find((a) => a.account.name === action.account)?.servers ?? []).filter(
        (server) => server.window,
      )
      const failed: Array<string> = []
      for (const server of servers) {
        await restartRcServer($, action.hostId, action.account, server).catch((err) =>
          failed.push(`${server.folder}: ${errorText(err)}`),
        )
      }
      return failed.length
        ? { tone: 'error', text: `Restarted ${servers.length - failed.length} of ${servers.length}.`, detail: failed.join('\n') }
        : { tone: 'success', text: `Restarted ${count(servers.length, 'Remote Control server')} on ${host?.label ?? 'the host'}` }
    }
    case 'stop': {
      const t = action.target
      await callHost($, t.hostId, 'POST', sessionPath(t.account, t.sessionId, 'stop'), {})
      return { tone: 'success', text: 'Stopped', detail: t.title }
    }
    case 'archive': {
      const t = action.target
      await callHost($, t.hostId, 'POST', sessionPath(t.account, t.sessionId, 'archive'), {})
      return { tone: 'success', text: 'Archived', detail: t.title }
    }
    case 'deleteArchive': {
      const freed = (await callHost(
        $,
        action.hostId,
        'DELETE',
        `/v1/accounts/${enc(action.account)}/archived/${enc(action.id)}/${enc(action.archive)}`,
      )) as { freedBytes: number }
      await loadArchived($, `${action.hostId}/${action.account}`)
      return { tone: 'success', text: `Deleted, freeing ${formatBytes(freed.freedBytes ?? 0)}`, detail: action.title }
    }
    case 'restartAll': {
      const current = await read($, view)
      const host = current.hosts.find((known) => known.id === action.hostId)
      const sessions =
        host?.accounts.find((a) => a.account.name === action.account)?.sessions.filter((s) => s.running) ?? []
      const failed: Array<string> = []
      let waiting = 0
      for (const s of sessions) {
        try {
          const launch = (await callHost(
            $,
            action.hostId,
            'POST',
            sessionPath(action.account, s.id, 'restart'),
            { trustFolder: true },
            60,
          )) as LaunchResult
          if (launch.attention) waiting += 1
        } catch (err) {
          failed.push(`${sessionTitle(s)}: ${errorText(err)}`)
        }
      }
      const label = host?.label ?? 'the host'
      if (failed.length)
        return {
          tone: 'error',
          text: `Restarted ${sessions.length - failed.length} of ${sessions.length}.`,
          detail: failed.join('\n'),
        }
      return {
        tone: 'success',
        text: `Restarted ${count(sessions.length, 'session')} on ${label}`,
        detail: waiting ? `${waiting} ${waiting === 1 ? 'is' : 'are'} waiting for you in its window.` : undefined,
      }
    }
    case 'signOut': {
      const result = (await callHost(
        $,
        action.hostId,
        'POST',
        `/v1/accounts/${enc(action.account)}/logout`,
        {
          stopRunning: action.running > 0,
          resumeAfterSignIn: false,
        },
        60,
      )) as LogoutResult
      return {
        tone: 'success',
        text: `Signed out ${action.account}`,
        detail: result.stopped
          ? `${count(result.stopped, 'running session')} ${result.stopped === 1 ? 'was' : 'were'} stopped first.`
          : undefined,
      }
    }
    case 'deleteAccount': {
      const result = (await callHost($, action.hostId, 'DELETE', `/v1/accounts/${enc(action.account)}`)) as {
        trashedTo: string
      }
      await update($, selected, () => null)
      return { tone: 'success', text: `Deleted ${action.account}`, detail: `Moved to ${result.trashedTo}.` }
    }
    case 'removeHost': {
      const host = await hostById($, action.hostId)
      try {
        await call($, host, 'DELETE', '/v1/clients/self', undefined, 10)
      } catch {
        // Unreachable: forget it here anyway.
      }
      await $.process.run(['/bin/sh', `${$.plugin.root}/scripts/forget-token.sh`, host.id], scriptTimeout(10))
      const list = ((await $.store.get('hosts')) ?? []) as Array<PairedHost>
      await $.store.set(
        'hosts',
        list.filter((known) => known.id !== host.id),
      )
      const removed = ((await $.store.get('removedHosts')) ?? []) as Array<string>
      await $.store.set('removedHosts', [...new Set([...removed, host.id])])
      await update($, selected, () => null)
      return { tone: 'success', text: `Removed ${host.label}` }
    }
  }
}

// ── Dialogs ──

async function openDialog($: Engine, value: ConductorDialog) {
  stopDialogTimers()
  await update($, dialog, () => value)
  const current = await read($, view)
  await $.ui.open({
    id: DIALOG,
    title: dialogTitle(value, current),
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
    rows: dialogRows(value),
  })
}

/** Changes the open dialog, if it's still the kind the change is for. */
async function patchDialog($: Engine, kind: ConductorDialog['kind'], patch: Record<string, unknown>) {
  await update($, dialog, (d) => (d && d.kind === kind ? ({ ...d, ...patch } as ConductorDialog) : d))
}

function stopDialogTimers() {
  windowTimer?.cancel()
  windowTimer = null
  moveTimer?.cancel()
  moveTimer = null
}

/** Closes the dialog pane; its `ui.close` hook tidies up. */
async function closeDialog($: Engine) {
  await $.ui.close({ id: DIALOG })
}

/** What closing the dialog leaves behind: a sign-in still open is cancelled. */
async function tidyDialog($: Engine) {
  stopDialogTimers()
  const d = await read($, dialog)
  if (d?.kind === 'signIn' && d.loginId && d.phase !== 'ended') {
    try {
      await callHost($, d.hostId, 'DELETE', `/v1/logins/${enc(d.loginId)}`, undefined, 10)
    } catch {
      // The sign-in expires by itself.
    }
  }
  await update($, dialog, () => null)
}

async function openWindowDialog($: Engine, target: ConductorTarget, windowId: string, launch: LaunchResult | null) {
  typedUpTo = 0
  liveTyped = ''
  await openDialog($, {
    kind: 'window',
    target,
    windowId,
    ack: 0,
    launch,
    screen: null,
    text: '',
    error: null,
    isGone: false,
  })
  await readWindow($)
  windowTimer = $.clock.every(1000, () => void readWindow($))
}

async function readWindow($: Engine) {
  const d = await read($, dialog)
  if (d?.kind !== 'window' || d.isGone) return
  try {
    const screen = (await callHost(
      $,
      d.target.hostId,
      'GET',
      `/v1/accounts/${enc(d.target.account)}/windows/${enc(d.windowId)}/screen`,
      undefined,
      10,
    )) as WindowScreen
    const hadSession = Boolean(d.screen?.sessionId)
    await patchDialog($, 'window', { screen, error: null })
    if (screen.sessionId && !hadSession && d.launch) void refresh($)
  } catch (err) {
    if (errorCode(err) === 'window_gone') {
      windowTimer?.cancel()
      windowTimer = null
      await patchDialog($, 'window', { isGone: true, error: null })
      void refresh($)
    } else {
      await patchDialog($, 'window', { error: errorText(err, 'The window could not be read.') })
    }
  }
}

async function sendKeys($: Engine, keys: Array<WindowKey>, isLive = false) {
  const d = await read($, dialog)
  if (d?.kind !== 'window' || keys.length === 0) return
  try {
    const screen = (await callHost(
      $,
      d.target.hostId,
      'POST',
      `/v1/accounts/${enc(d.target.account)}/windows/${enc(d.windowId)}/keys`,
      { keys },
      15,
    )) as WindowScreen
    await patchDialog($, 'window', isLive ? { screen, error: null } : { screen, text: '', error: null })
  } catch (err) {
    if (errorCode(err) === 'window_gone') await patchDialog($, 'window', { isGone: true })
    else await patchDialog($, 'window', { error: errorText(err, 'That key did not get through.') })
  }
}

/** What the live Type field held at its last change, and its sends in order. */
let liveTyped = ''
let liveSends: Promise<void> = Promise.resolve()

/** The live Type field changed: type what was added, Backspace what was removed. */
async function typeLive($: Engine, value: string) {
  const keys = liveEdit(liveTyped, value)
  liveTyped = value
  await patchDialog($, 'window', { text: value })
  if (keys.length === 0) return
  liveSends = liveSends.then(() => sendKeys($, keys, true))
  await liveSends
}

/** Enter in the live Type field: Enter in the window, and the field starts over. */
async function submitLive($: Engine) {
  liveTyped = ''
  await patchDialog($, 'window', { text: '' })
  liveSends = liveSends.then(() => sendKeys($, [{ key: 'Enter' }], true))
  await liveSends
}

/** `ssh -t <host> '<tmux attach …>'`, only for the shapes the server makes. */
function sshAttach(hostname: string, attach: string): string | null {
  const isHost = /^(?![-.])[A-Za-z0-9.-]{1,253}$/.test(hostname)
  const isAttach = /^tmux (-L [A-Za-z0-9_-]{1,64} )?attach -t [A-Za-z0-9_-]{1,64} ; select-window -t @\d{1,9}$/.test(
    attach,
  )
  return isHost && isAttach ? `ssh -t ${hostname} '${attach}'` : null
}

async function attachCommand($: Engine): Promise<string | null> {
  const d = await read($, dialog)
  if (d?.kind !== 'window') return null
  const host = (await read($, view)).hosts.find((known) => known.id === d.target.hostId)
  const attach =
    d.launch?.attachCommand ?? `tmux attach -t ${host?.info?.tmux?.session ?? 'ai'} ; select-window -t ${d.windowId}`
  return host ? sshAttach(host.hostname, attach) : null
}

async function copyAttach($: Engine) {
  const command = await attachCommand($)
  if (!command) {
    await patchDialog($, 'window', { error: "The host described its window in a way this Mac won't run." })
    return
  }
  const copied = await $.ui.copy({ text: command })
  await patchDialog($, 'window', { error: copied.isCopied ? null : 'Could not copy it.' })
  if (copied.isCopied) $.ui.toast('Attach command copied')
}

async function openTerminal($: Engine) {
  const command = await attachCommand($)
  if (!command) {
    await patchDialog($, 'window', { error: "The host described its window in a way this Mac won't run." })
    return
  }
  const d = await read($, dialog)
  if (d?.kind === 'window' && isDemoHost(d.target.hostId)) {
    $.ui.toast('Demo mode: Terminal stays closed')
    return
  }
  const quoted = command.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  const run = await $.process.run([
    '/usr/bin/osascript',
    '-e',
    'tell application "Terminal"',
    '-e',
    'activate',
    '-e',
    `do script "${quoted}"`,
    '-e',
    'end tell',
  ])
  if (run.exitCode !== 0) await patchDialog($, 'window', { error: run.stderr.trim() || 'Could not open Terminal.' })
}

// Pairing

async function computerName($: Engine): Promise<string> {
  const run = await $.process.run(['/usr/sbin/scutil', '--get', 'ComputerName'])
  return run.exitCode === 0 && run.stdout.trim() ? run.stdout.trim().slice(0, 128) : 'Remote Control CLI Servers'
}

async function pair($: Engine, code: string, wantedLabel: string): Promise<string> {
  if (await isDemo($)) throw new Error('Demo mode is on: /remote-control-cli-servers demo turns it off, then pair.')
  const decoded = decodePairingCode(code)
  if ('error' in decoded) throw new Error(decoded.error || "That isn't a pairing code.")
  const existing = (await pairedHosts($)).find((known) => known.fingerprint === decoded.fingerprint)
  const id = existing?.id ?? progressId()
  const body = JSON.stringify({ secret: decoded.secret, clientName: await computerName($) })
  for (const address of decoded.hosts) {
    const key = await pinFor($, { id, fingerprint: decoded.fingerprint }, address)
    if (!key) continue
    const run = await $.process.run(
      ['/bin/sh', `${$.plugin.root}/scripts/pair.sh`, address, key, body, id],
      scriptTimeout(25),
    )
    const answer = readCurl(run, false)
    if (answer === null) continue
    const paired = answer as PairResponse
    const label = wantedLabel.trim() || existing?.label || paired.info.hostname
    await saveHost($, {
      id,
      label,
      hostname: paired.info.hostname,
      addresses: decoded.hosts,
      fingerprint: decoded.fingerprint,
      clientId: paired.clientId,
      pairedAt: new Date(await $.clock.now()).toISOString(),
      lastGoodAddress: address,
    })
    answeredOn.set(id, address)
    return label
  }
  throw new RemoteError('offline', `None of its addresses answered: ${decoded.hosts.join(', ')}.`)
}

// Sign-in

function isSignInUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && !parsed.port && !parsed.username && SIGN_IN_HOSTS.includes(parsed.hostname)
  } catch {
    return false
  }
}

async function startSignIn($: Engine) {
  const d = await read($, dialog)
  if (d?.kind !== 'signIn') return
  await patchDialog($, 'signIn', { phase: 'starting', error: null, code: '', loginId: null, url: null })
  try {
    const login = (await callHost($, d.hostId, 'POST', `/v1/accounts/${enc(d.account)}/login`, {}, 40)) as LoginStart
    if (!isSignInUrl(login.url)) {
      throw new RemoteError(
        'login_failed',
        "The host offered a sign-in link to an unexpected site, so it wasn't opened.",
      )
    }
    await openUrl($, login.url, d.hostId)
    await patchDialog($, 'signIn', { phase: 'code', loginId: login.loginId, url: login.url })
  } catch (err) {
    await patchDialog($, 'signIn', { phase: 'ended', error: errorText(err, 'Signing in could not start.') })
  }
}

async function submitSignIn($: Engine, d: Extract<ConductorDialog, { kind: 'signIn' }>) {
  if (d.phase === 'confirmSwitch') {
    try {
      await callHost(
        $,
        d.hostId,
        'POST',
        `/v1/accounts/${enc(d.account)}/logout`,
        { stopRunning: true, resumeAfterSignIn: true },
        60,
      )
    } catch (err) {
      await patchDialog($, 'signIn', { error: errorText(err, 'It could not be signed out.') })
      return
    }
    await startSignIn($)
    return
  }
  if (d.phase !== 'code' || !d.loginId || !d.code.trim()) return
  await patchDialog($, 'signIn', { phase: 'submitting', error: null })
  try {
    const account = (await callHost(
      $,
      d.hostId,
      'POST',
      `/v1/logins/${enc(d.loginId)}/code`,
      { code: d.code.trim() },
      75,
    )) as RemoteAccount
    await patchDialog($, 'signIn', { loginId: null })
    await closeDialog($)
    const email = account.account?.email ?? null
    const label = await hostLabel($, d.hostId)
    const resuming = account.pendingResume
      ? `${count(account.pendingResume, 'session')} resuming, in the same conversations.`
      : `On ${label}.`
    if (d.isSwitch && email && d.previousEmail && email.toLowerCase() === d.previousEmail.toLowerCase()) {
      await setNote($, {
        tone: 'info',
        text: `Still ${email}`,
        detail: `The browser was still signed in to claude.ai as ${email}. Switch account on claude.ai first, then switch again. Its sessions are running again meanwhile.`,
      })
    } else if (d.isSwitch) {
      await setNote($, { tone: 'success', text: `${d.account} is on ${email ?? 'another account'}`, detail: resuming })
    } else {
      await setNote($, {
        tone: 'success',
        text: `Signed in ${d.account}`,
        detail: email ? `As ${email}, on ${label}.` : `On ${label}.`,
      })
    }
    void refresh($)
  } catch (err) {
    const isOver = errorCode(err) === 'login_failed' || errorCode(err) === 'login_expired'
    await patchDialog($, 'signIn', {
      phase: isOver ? 'ended' : 'code',
      loginId: isOver ? null : d.loginId,
      error: errorText(err, 'Signing in did not work.'),
    })
  }
}

// New session

async function browse($: Engine, path: string | null) {
  const d = await read($, dialog)
  if (d?.kind !== 'newSession') return
  try {
    const query = path ? `?path=${enc(path)}` : ''
    const listing = (await callHost($, d.hostId, 'GET', `/v1/fs/dirs${query}`, undefined, 15)) as DirListing
    await patchDialog($, 'newSession', {
      listing,
      error: null,
      ...(d.isNameTouched ? {} : { name: folderName(listing.path) }),
    })
  } catch (err) {
    await patchDialog($, 'newSession', { error: errorText(err, 'That folder could not be listed.') })
  }
}

async function startSession($: Engine, d: Extract<ConductorDialog, { kind: 'newSession' }>) {
  if (!d.listing) return
  if (d.isServer) return startServer($, d)
  await patchDialog($, 'newSession', { isBusy: true, error: null })
  try {
    const name = d.name.trim()
    const launch = (await callHost(
      $,
      d.hostId,
      'POST',
      `/v1/accounts/${enc(d.account)}/sessions`,
      {
        cwd: d.listing.path,
        ...(name ? { name } : {}),
        trustFolder: d.trustFolder,
      },
      45,
    )) as LaunchResult
    const title = launch.remoteControlName ?? (name || folderName(d.listing.path))
    const target = { hostId: d.hostId, account: d.account, sessionId: launch.sessionId ?? '', title }
    if (launch.attention || launch.alreadyRunning) {
      await openWindowDialog($, target, launch.window.windowId, launch)
    } else {
      await closeDialog($)
      await setNote($, {
        tone: 'success',
        text: `Started ${title}`,
        detail: `In tmux window ${launch.window.windowId}, with Remote Control on: it's in the Claude app on your other devices.`,
      })
    }
    void refresh($)
  } catch (err) {
    await patchDialog($, 'newSession', { isBusy: false, error: errorText(err, 'The session could not be started.') })
  }
}

/** Start a Remote Control server in the dialog's folder, or show the one running there. */
async function startServer($: Engine, d: Extract<ConductorDialog, { kind: 'newSession' }>) {
  if (!d.listing) return
  await patchDialog($, 'newSession', { isBusy: true, error: null })
  try {
    const name = d.name.trim()
    const started = (await callHost(
      $,
      d.hostId,
      'POST',
      `/v1/accounts/${enc(d.account)}/rc-servers`,
      { folder: d.listing.path, ...(name ? { name } : {}), spawn: d.spawn, trustFolder: d.trustFolder },
      45,
    )) as StartRcServerResult
    const server = started.server
    const title = server.name ?? folderName(server.folder)
    if (server.attention && server.window) {
      const target = { hostId: d.hostId, account: d.account, sessionId: '', title }
      await openWindowDialog($, target, server.window.windowId, null)
    } else {
      await closeDialog($)
      await setNote($, {
        tone: 'success',
        text: started.alreadyRunning ? `A Remote Control server already runs in ${title}` : `Started a Remote Control server in ${title}`,
        detail: 'Start sessions in this folder from claude.ai or the Claude app: it shows up as an environment there.',
      })
    }
    void refresh($)
  } catch (err) {
    const message =
      errorCode(err) === 'http_404'
        ? 'This host’s server is too old to start Remote Control servers: update it first.'
        : errorText(err, 'The Remote Control server could not be started.')
    await patchDialog($, 'newSession', { isBusy: false, error: message })
  }
}

// Move

async function planMove($: Engine, to: string) {
  const d = await read($, dialog)
  if (d?.kind !== 'move') return
  await patchDialog($, 'move', {
    to,
    plan: null,
    choices: {},
    merged: {},
    merging: null,
    replaceNewer: false,
    error: null,
  })
  try {
    const t = d.target
    const plan = (await callHost(
      $,
      t.hostId,
      'GET',
      `${sessionPath(t.account, t.sessionId, 'transfer')}?to=${enc(to)}`,
      undefined,
      30,
    )) as TransferPlan
    await update($, dialog, (current) =>
      current?.kind === 'move' && current.to === to ? { ...current, plan } : current,
    )
  } catch (err) {
    await patchDialog($, 'move', { error: errorText(err, 'Could not work out the move.') })
  }
}

async function mergeMemory($: Engine, path: string) {
  const d = await read($, dialog)
  if (d?.kind !== 'move') return
  await patchDialog($, 'move', { merging: path, error: null })
  try {
    const t = d.target
    const result = (await callHost(
      $,
      t.hostId,
      'POST',
      `${sessionPath(t.account, t.sessionId, 'transfer')}/merge-memory`,
      { to: d.to, path },
      180,
    )) as { merged: string }
    await update($, dialog, (current) =>
      current?.kind === 'move'
        ? {
            ...current,
            merging: null,
            merged: { ...current.merged, [path]: result.merged },
            choices: { ...current.choices, [path]: 'merged' as const },
          }
        : current,
    )
  } catch (err) {
    await patchDialog($, 'move', {
      merging: null,
      error: `The merge failed; choose another option. ${errorText(err, '')}`.trim(),
    })
  }
}

async function move($: Engine, d: Extract<ConductorDialog, { kind: 'move' }>) {
  const plan = d.plan
  if (!plan) return
  const t = d.target
  const id = progressId()
  await patchDialog($, 'move', { phase: 'moving', progress: null, error: null })
  moveTimer = $.clock.every(500, () => {
    void (async () => {
      try {
        const progress = (await callHost($, t.hostId, 'GET', `/v1/moves/${id}`, undefined, 5)) as MoveProgress
        await patchDialog($, 'move', { progress })
      } catch {
        // Not started yet, or done.
      }
    })()
  })
  const afterwards: Afterwards = d.afterwards
  try {
    const report = (await callHost(
      $,
      t.hostId,
      'POST',
      sessionPath(t.account, t.sessionId, 'transfer'),
      {
        to: d.to,
        stopFirst: isRunning(plan),
        confirmRunning: false,
        replaceNewer: d.replaceNewer,
        memory: memoryDecisions(plan, d.choices, d.merged),
        archiveSource: afterwards === 'archive',
        deleteSource: afterwards === 'delete',
        resume: d.resume,
        trustFolder: true,
        progressId: id,
      },
      600,
    )) as TransferReport
    moveTimer?.cancel()
    moveTimer = null
    const moved = { ...t, account: d.to }
    if (report.deleteError)
      await setNote($, {
        tone: 'error',
        text: `Moved to ${d.to}. The session on ${t.account} was kept.`,
        detail: report.deleteError,
      })
    if (report.resumeError) {
      await closeDialog($)
      await setNote($, { tone: 'error', text: `Moved to ${d.to}, but it didn't resume.`, detail: report.resumeError })
    } else if (report.launch?.attention) {
      await openWindowDialog($, moved, report.launch.window.windowId, report.launch)
    } else {
      await closeDialog($)
      if (!report.deleteError) {
        await setNote($, {
          tone: 'success',
          text: report.changed ? `Moved to ${d.to}` : `${d.to} was already up to date`,
          detail: movedDetails(report, t.account) || undefined,
        })
      }
    }
    await update($, selected, () => null)
    void refresh($)
  } catch (err) {
    moveTimer?.cancel()
    moveTimer = null
    await patchDialog($, 'move', { phase: 'form', error: errorText(err, 'The session could not be moved.') })
    await planMove($, d.to)
    await patchDialog($, 'move', { error: errorText(err, 'The session could not be moved.') })
  }
}

// Submitting each dialog

async function submitDialog($: Engine) {
  const d = await read($, dialog)
  if (!d) return
  switch (d.kind) {
    case 'pair': {
      if (d.isBusy) return
      await patchDialog($, 'pair', { isBusy: true, error: null })
      try {
        const label = await pair($, d.code, d.label)
        await closeDialog($)
        await setNote($, { tone: 'success', text: `Paired with ${label}.` })
        void refresh($)
      } catch (err) {
        await patchDialog($, 'pair', { isBusy: false, error: errorText(err, 'Pairing failed.') })
      }
      return
    }
    case 'host': {
      await patchDialog($, 'host', { isBusy: true, error: null })
      try {
        const host = await hostById($, d.hostId)
        const label = d.label.trim()
        if (label && label !== host.label) await saveHost($, { ...host, label })
        const info = (await read($, view)).hosts.find((known) => known.id === d.hostId)?.info
        const wanted = d.isSuffixOn ? d.suffix.trim() || label : null
        if (info?.settings && (info.settings.remoteControlSuffix ?? null) !== wanted) {
          const body: HostSettings = { remoteControlSuffix: wanted }
          await call($, host, 'PUT', '/v1/settings', body)
        }
        await closeDialog($)
        await setNote($, { tone: 'success', text: `Saved ${label || host.label}` })
        void refresh($)
      } catch (err) {
        await patchDialog($, 'host', { isBusy: false, error: errorText(err, 'The setting could not be saved.') })
      }
      return
    }
    case 'newAccount': {
      await patchDialog($, 'newAccount', { isBusy: true, error: null })
      try {
        const account = (await callHost($, d.hostId, 'POST', '/v1/accounts', { name: d.name.trim() })) as RemoteAccount
        void refresh($)
        await update(
          $,
          selected,
          (): ConductorSelection => ({ kind: 'account', hostId: d.hostId, account: account.name }),
        )
        await openSignInDialog($, d.hostId, account.name, false)
      } catch (err) {
        await patchDialog($, 'newAccount', { isBusy: false, error: errorText(err, 'Could not create the profile.') })
      }
      return
    }
    case 'renameAccount': {
      await patchDialog($, 'renameAccount', { isBusy: true, error: null })
      try {
        const host = (await read($, view)).hosts.find((known) => known.id === d.hostId)
        const running =
          host?.accounts.find((a) => a.account.name === d.account)?.sessions.filter((s) => s.running).length ?? 0
        const account = (await callHost(
          $,
          d.hostId,
          'POST',
          `/v1/accounts/${enc(d.account)}/rename`,
          {
            newName: d.name.trim(),
            stopRunning: running > 0,
          },
          60,
        )) as RemoteAccount
        await update(
          $,
          selected,
          (): ConductorSelection => ({ kind: 'account', hostId: d.hostId, account: account.name }),
        )
        await closeDialog($)
        await setNote($, { tone: 'success', text: `Renamed ${d.account} to ${account.name}` })
        void refresh($)
      } catch (err) {
        await patchDialog($, 'renameAccount', { isBusy: false, error: errorText(err, 'Could not save it.') })
      }
      return
    }
    case 'signIn':
      return submitSignIn($, d)
    case 'newSession':
      return startSession($, d)
    case 'renameSession': {
      await patchDialog($, 'renameSession', { isBusy: true, error: null })
      try {
        const t = d.target
        const wanted = d.name.trim()
        const result = (await callHost(
          $,
          t.hostId,
          'POST',
          sessionPath(t.account, t.sessionId, 'rename'),
          { name: wanted },
          30,
        )) as RenameSessionResult
        await closeDialog($)
        await setNote($, {
          tone: result.name === wanted ? 'success' : 'info',
          text: `Renamed to ${result.name}`,
          detail:
            result.name !== wanted
              ? `Another running session is called ${wanted}, so Claude added a suffix.`
              : result.live
                ? 'In the Claude app too.'
                : 'The Claude app shows it once the session is resumed.',
        })
        void refresh($)
      } catch (err) {
        await patchDialog($, 'renameSession', { isBusy: false, error: errorText(err, 'Could not rename it.') })
      }
      return
    }
    case 'move':
      return move($, d)
    case 'window':
      return
    case 'confirm': {
      if (d.isBusy) return
      await patchDialog($, 'confirm', { isBusy: true, error: null })
      try {
        const result = await runConfirmed($, d.action)
        await closeDialog($)
        await setNote($, result)
        void refresh($)
      } catch (err) {
        await patchDialog($, 'confirm', { isBusy: false, error: errorText(err) })
      }
      return
    }
  }
}

async function openSignInDialog($: Engine, hostId: string, account: string, isSwitch: boolean) {
  const host = (await read($, view)).hosts.find((known) => known.id === hostId)
  const email = host?.accounts.find((a) => a.account.name === account)?.account.account?.email ?? null
  await openDialog($, {
    kind: 'signIn',
    hostId,
    account,
    phase: isSwitch ? 'confirmSwitch' : 'starting',
    isSwitch,
    previousEmail: email,
    loginId: null,
    url: null,
    code: '',
    error: null,
  })
  if (!isSwitch) await startSignIn($)
}

async function openNewSession($: Engine, hostId: string, account: string, isServer = false, folder: string | null = null) {
  await openDialog($, {
    kind: 'newSession',
    hostId,
    account,
    isServer,
    spawn: 'same-dir',
    listing: null,
    name: '',
    isNameTouched: false,
    trustFolder: true,
    error: null,
    isBusy: false,
  })
  await browse($, folder)
}

async function openMove($: Engine, target: ConductorTarget) {
  const host = (await read($, view)).hosts.find((known) => known.id === target.hostId)
  const to = host?.accounts.map((a) => a.account.name).find((n) => n !== target.account) ?? ''
  await openDialog($, {
    kind: 'move',
    target,
    to,
    plan: null,
    choices: {},
    merged: {},
    merging: null,
    replaceNewer: false,
    afterwards: 'archive',
    resume: true,
    progress: null,
    phase: 'form',
    error: null,
  })
  if (to) await planMove($, to)
}

// ── Tools for Claude ──

const TOOL_PREFIX = 'mcp__remote-control-cli-servers__'

/** Lists the tools for Claude; a session that takes none (`--tools ""`) refuses them, and that's fine. */
async function registerTools($: Engine) {
  for (const spec of TOOL_SPECS) {
    try {
      await $.tool.register(spec)
    } catch {
      return
    }
  }
}

type ToolInput = Record<string, unknown>

const str = (input: ToolInput, key: string): string => {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Say ${key}.`)
  return value.trim()
}

/** "host/account" to the paired host and the account as the server names it. */
async function resolveProfile($: Engine, ref: string) {
  const parts = splitProfile(ref)
  if (!isFound(parts)) throw new Error(parts.error)
  const host = findHost(await pairedHosts($), parts.host)
  if (!isFound(host)) throw new Error(host.error)
  const accounts = (await call($, host, 'GET', '/v1/accounts')) as Array<RemoteAccount>
  const account = accounts.find((a) => a.name.toLowerCase() === parts.account.toLowerCase())
  if (!account) {
    throw new Error(
      `${host.label} has no account called "${parts.account}". Its accounts: ${accounts.map((a) => a.name).join(', ')}.`,
    )
  }
  return { host, account }
}

async function resolveSession($: Engine, host: PairedHost, account: string, ref: string) {
  const sessions = (await call($, host, 'GET', `/v1/accounts/${enc(account)}/sessions`)) as Array<RemoteSession>
  const found = findSession(sessions, ref)
  if (!isFound(found)) throw new Error(found.error)
  return found
}

/** A Remote Control server, as the tools report it. */
function serverJson(server: RcServer) {
  return {
    folder: server.folder,
    name: server.name,
    spawn: server.spawn,
    sessions: server.sessions,
    startedHere: server.window !== null,
    environmentUrl: server.environmentUrl,
    attention: server.attention,
  }
}

function launchJson(launch: LaunchResult) {
  return {
    window: launch.window.windowId,
    alreadyRunning: launch.alreadyRunning,
    sessionId: launch.sessionId,
    remoteControlName: launch.remoteControlName,
    attention: launch.attention,
    next: launch.attention
      ? 'Claude is asking something in its window: read_window shows it, send_to_window answers it.'
      : undefined,
  }
}

async function runTool($: Engine, name: string, input: ToolInput): Promise<unknown> {
  switch (name) {
    case 'list_profiles': {
      const hosts = await pairedHosts($)
      return {
        hosts: await Promise.all(
          hosts.map(async (host) => {
            try {
              const accounts = (await call($, host, 'GET', '/v1/accounts', undefined, 8)) as Array<RemoteAccount>
              return {
                host: host.label,
                online: true,
                accounts: accounts.map((a) => ({
                  profile: `${host.label}/${a.name}`,
                  account: a.account?.email ?? null,
                  plan: a.account?.plan ?? null,
                  signedIn: a.signedIn,
                  sessions: a.sessions,
                  running: a.runningSessions,
                })),
              }
            } catch (err) {
              return { host: host.label, online: false, error: errorText(err) }
            }
          }),
        ),
      }
    }
    case 'list_sessions': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      if (input.archived === true) {
        return await call($, host, 'GET', `/v1/accounts/${enc(account.name)}/archived`)
      }
      const sessions = (await call(
        $,
        host,
        'GET',
        `/v1/accounts/${enc(account.name)}/sessions`,
      )) as Array<RemoteSession>
      return sessions.map(sessionJson)
    }
    case 'host_info': {
      const host = findHost(await pairedHosts($), str(input, 'host'))
      if (!isFound(host)) throw new Error(host.error)
      return await call($, host, 'GET', '/v1/info')
    }
    case 'list_folders': {
      const host = findHost(await pairedHosts($), str(input, 'host'))
      if (!isFound(host)) throw new Error(host.error)
      const path = typeof input.path === 'string' && input.path.trim() ? `?path=${enc(input.path.trim())}` : ''
      return await call($, host, 'GET', `/v1/fs/dirs${path}`)
    }
    case 'new_session': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      const launch = (await call(
        $,
        host,
        'POST',
        `/v1/accounts/${enc(account.name)}/sessions`,
        {
          cwd: str(input, 'folder'),
          ...(typeof input.name === 'string' && input.name.trim() ? { name: input.name.trim() } : {}),
          trustFolder: input.trust_folder !== false,
        },
        45,
      )) as LaunchResult
      void refresh($)
      return launchJson(launch)
    }
    case 'list_rc_servers': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      const servers = await readServers($, host, account.name)
      if (servers === null) throw new Error(`${host.label}'s server is too old for Remote Control servers: update it.`)
      return { servers: servers.map(serverJson) }
    }
    case 'start_rc_server': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      const spawn = input.spawn === 'worktree' ? 'worktree' : 'same-dir'
      const started = (await call(
        $,
        host,
        'POST',
        `/v1/accounts/${enc(account.name)}/rc-servers`,
        {
          folder: str(input, 'folder'),
          ...(typeof input.name === 'string' && input.name.trim() ? { name: input.name.trim() } : {}),
          spawn,
          trustFolder: input.trust_folder !== false,
        },
        45,
      )) as StartRcServerResult
      void refresh($)
      return { alreadyRunning: started.alreadyRunning, server: serverJson(started.server) }
    }
    case 'stop_rc_server': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      const folder = str(input, 'folder').replace(/\/+$/, '')
      const servers = (await readServers($, host, account.name)) ?? []
      const server = servers.find(
        (s) => s.folder === folder || (folder.startsWith('~/') && s.folder.endsWith(folder.slice(1))),
      )
      if (!server) throw new Error(`No Remote Control server runs in ${folder} for ${host.label}/${account.name}.`)
      await call($, host, 'POST', `/v1/accounts/${enc(account.name)}/rc-servers/${server.pid}/stop`, {})
      void refresh($)
      return { stopped: server.folder, sessions: server.sessions }
    }
    case 'resume_session':
    case 'restart_session': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      const s = await resolveSession($, host, account.name, str(input, 'session'))
      if (name === 'restart_session' && !s.running)
        throw new Error(`${sessionTitle(s)} isn't running: resume it instead.`)
      const action = name === 'resume_session' ? 'resume' : 'restart'
      const launch = (await call(
        $,
        host,
        'POST',
        sessionPath(account.name, s.id, action),
        { trustFolder: true },
        60,
      )) as LaunchResult
      void refresh($)
      return launchJson(launch)
    }
    case 'restart_outdated': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      const sessions = (await call(
        $,
        host,
        'GET',
        `/v1/accounts/${enc(account.name)}/sessions`,
      )) as Array<RemoteSession>
      const outdated = sessions.filter((s) => s.running && s.updatePending)
      const results = []
      for (const s of outdated) {
        try {
          const launch = (await call(
            $,
            host,
            'POST',
            sessionPath(account.name, s.id, 'restart'),
            { trustFolder: true },
            60,
          )) as LaunchResult
          results.push({ session: sessionTitle(s), restarted: true, attention: launch.attention ?? undefined })
        } catch (err) {
          results.push({ session: sessionTitle(s), restarted: false, error: errorText(err) })
        }
      }
      void refresh($)
      return { restarted: results.filter((r) => r.restarted).length, sessions: results }
    }
    case 'stop_session': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      const s = await resolveSession($, host, account.name, str(input, 'session'))
      const result = await call($, host, 'POST', sessionPath(account.name, s.id, 'stop'), {})
      void refresh($)
      return result
    }
    case 'rename_session': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      const s = await resolveSession($, host, account.name, str(input, 'session'))
      const result = await call(
        $,
        host,
        'POST',
        sessionPath(account.name, s.id, 'rename'),
        { name: str(input, 'name') },
        30,
      )
      void refresh($)
      return result
    }
    case 'read_window':
    case 'send_to_window': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      const s = await resolveSession($, host, account.name, str(input, 'session'))
      if (!s.window) throw new Error(`${sessionTitle(s)} isn't running in a tmux window.`)
      const base = `/v1/accounts/${enc(account.name)}/windows/${enc(s.window.windowId)}`
      if (name === 'read_window') {
        const screen = (await call($, host, 'GET', `${base}/screen`)) as WindowScreen
        return { window: s.window.windowId, screen: screen.text }
      }
      const keys = Array.isArray(input.keys) ? (input.keys as Array<WindowKey>) : []
      if (keys.length === 0) throw new Error('Say what to send: keys, text, or both.')
      const screen = (await call($, host, 'POST', `${base}/keys`, { keys }, 15)) as WindowScreen
      return { window: s.window.windowId, screen: screen.text }
    }
    case 'open_in_claude': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      const s = await resolveSession($, host, account.name, str(input, 'session'))
      if (!s.bridgeSessionId) {
        throw new Error(
          `${sessionTitle(s)} has no Remote Control conversation: it isn't running, or it hasn't connected yet.`,
        )
      }
      const link = `https://claude.ai/code/${s.bridgeSessionId}`
      await openUrl($, link, host.id)
      return { openedIn: 'the browser', link }
    }
    case 'switch_account':
    case 'sign_in': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      let stopped = 0
      if (name === 'switch_account') {
        const result = (await call(
          $,
          host,
          'POST',
          `/v1/accounts/${enc(account.name)}/logout`,
          {
            stopRunning: true,
            resumeAfterSignIn: true,
          },
          60,
        )) as LogoutResult
        stopped = result.stopped
      }
      const login = (await call($, host, 'POST', `/v1/accounts/${enc(account.name)}/login`, {}, 40)) as LoginStart
      if (!isSignInUrl(login.url))
        throw new Error("The host offered a sign-in link to an unexpected site, so it wasn't opened.")
      await openUrl($, login.url, host.id)
      void refresh($)
      return {
        profile: `${host.label}/${account.name}`,
        wasSignedInAs: account.account?.email ?? null,
        stoppedSessions: stopped,
        signIn: { loginId: login.loginId, url: login.url, expiresAt: login.expiresAt },
        next: "The sign-in page is open in this Mac's browser. Sign in there (if claude.ai shows the wrong account, switch it first), then call finish_sign_in with the code the page shows.",
      }
    }
    case 'finish_sign_in': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      const done = (await call(
        $,
        host,
        'POST',
        `/v1/logins/${enc(str(input, 'login_id'))}/code`,
        { code: str(input, 'code') },
        75,
      )) as RemoteAccount
      void refresh($)
      return {
        profile: `${host.label}/${account.name}`,
        signedInAs: done.account?.email ?? null,
        plan: done.account?.plan ?? null,
        resumingSessions: done.pendingResume ?? 0,
      }
    }
    case 'plan_move':
    case 'move_session': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      const s = await resolveSession($, host, account.name, str(input, 'session'))
      const toRef = str(input, 'to')
      const to = toRef.includes('/') ? (await resolveProfile($, toRef)).account.name : toRef
      if (toRef.includes('/') && (await resolveProfile($, toRef)).host.id !== host.id) {
        throw new Error(
          `A session on ${host.label} moves to another account on ${host.label}: sessions don't move between hosts.`,
        )
      }
      const plan = (await call(
        $,
        host,
        'GET',
        `${sessionPath(account.name, s.id, 'transfer')}?to=${enc(to)}`,
      )) as TransferPlan
      if (name === 'plan_move') return plan
      if (plan.destinationNewer && input.replace_newer !== true) {
        throw new Error(
          `${to}'s copy of this session is newer than ${account.name}'s: moving would roll it back there. Pass replace_newer to go ahead anyway.`,
        )
      }
      const conflictPaths = plan.memory.filter((m) => m.action === 'conflict').map((m) => m.path)
      const decided = toolDecisions(
        input.memory as Record<string, unknown> | undefined,
        conflictPaths,
        (path) => plan.memory.find((m) => m.path === path)?.newer ?? 'source',
      )
      if (!isFound(decided)) throw new Error(decided.error)
      const afterwards = input.afterwards === 'delete' || input.afterwards === 'keep' ? input.afterwards : 'archive'
      const report = (await call(
        $,
        host,
        'POST',
        sessionPath(account.name, s.id, 'transfer'),
        {
          to,
          stopFirst: isRunning(plan),
          confirmRunning: false,
          replaceNewer: input.replace_newer === true,
          memory: decided.decisions,
          archiveSource: afterwards === 'archive',
          deleteSource: afterwards === 'delete',
          resume: input.resume !== false,
          trustFolder: true,
        },
        600,
      )) as TransferReport
      void refresh($)
      return report
    }
    case 'archive_session': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      const s = await resolveSession($, host, account.name, str(input, 'session'))
      const result = await call($, host, 'POST', sessionPath(account.name, s.id, 'archive'), {})
      void refresh($)
      return result
    }
    case 'restore_session':
    case 'delete_archive': {
      const { host, account } = await resolveProfile($, str(input, 'profile'))
      const list = (await call($, host, 'GET', `/v1/accounts/${enc(account.name)}/archived`)) as Array<ArchivedSession>
      const found = findSession(
        list.map((a) => ({ ...a, lastPrompt: null })),
        str(input, 'session'),
      )
      if (!isFound(found)) throw new Error(found.error)
      const archives = list.filter((a) => a.id === found.id)
      const wanted = typeof input.archive === 'string' && input.archive.trim() ? input.archive.trim() : null
      if (name === 'delete_archive' && !wanted)
        throw new Error('Say which archive: list_sessions with archived=true shows them.')
      const archive = wanted ? archives.find((a) => a.archive === wanted) : archives[0]
      if (!archive)
        throw new Error(
          `That session has no archive "${wanted}". Its archives: ${archives.map((a) => a.archive).join(', ')}.`,
        )
      const path = `/v1/accounts/${enc(account.name)}/archived/${enc(archive.id)}/${enc(archive.archive)}`
      const result =
        name === 'restore_session'
          ? await call($, host, 'POST', `${path}/restore`, {})
          : await call($, host, 'DELETE', path)
      void refresh($)
      return result
    }
    default:
      throw new Error(`No tool is called ${name}.`)
  }
}

// ── What the views call ──

function viewActions($: Engine): Act {
  return {
    refresh: () => void refresh($),
    select: (value) => void update($, selected, () => value),
    toggleArchived: (hostId, account) => {
      const key = `${hostId}/${account}`
      void (async () => {
        const shown = await read($, archived)
        if (key in shown) {
          const { [key]: _, ...rest } = shown
          await update($, archived, () => rest)
        } else {
          await update($, archived, (all) => ({ ...all, [key]: [] }))
          await loadArchived($, key)
        }
      })()
    },
    toggleShowAll: (hostId, account) => {
      const key = `${hostId}/${account}`
      void update($, showAll, (list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]))
    },
    dismissNote: () => void setNote($, null),
    openSettings: () => void openSettings($),
    toggleMenu: (key) => void update($, openMenu, () => key),
    resume: (t) => void resume($, t),
    restart: (t) => void restart($, t),
    openClaude: (t, bridge) => void openOnClaude($, t, bridge),
    openClaudeApp: (t, bridge) => void openInClaudeApp($, t, bridge),
    openEnvironment: (hostId, url) =>
      void (url.startsWith('https://claude.ai/code?environment=') && openUrl($, url, hostId)),
    openWindow: (t, windowId) => void openWindowDialog($, t, windowId, null),
    restore: (hostId, account, a) => void restore($, hostId, account, a),
    confirm: (action) => void (async () => openDialog($, await confirmDialog($, action)))(),
    openDialog: (value) => void openDialog($, value),
    openNewSession: (hostId, account) => void openNewSession($, hostId, account),
    openNewServer: (hostId, account, folder) => void openNewSession($, hostId, account, true, folder),
    openSignIn: (hostId, account, isSwitch) => void openSignInDialog($, hostId, account, isSwitch),
    openMove: (t) => void openMove($, t),
  }
}

function dialogActions($: Engine): DialogAct {
  return {
    close: () => void closeDialog($),
    patch: (patch) => void update($, dialog, (d) => (d ? ({ ...d, ...patch } as ConductorDialog) : d)),
    submit: () => void submitDialog($),
    removeHost: (hostId) => void (async () => openDialog($, await confirmDialog($, { kind: 'removeHost', hostId })))(),
    setBand: (isOn) => void setBand($, isOn),
    setDemo: (isOn) => void setDemo($, isOn),
    browse: (path) => void browse($, path),
    startSignIn: () => void startSignIn($),
    openUrl: (url) => void $.process.run(['/usr/bin/open', url]),
    moveTo: (account) => void planMove($, account),
    merge: (path) => void mergeMemory($, path),
    sendKeys: (keys) => void sendKeys($, keys),
    typeLive: (value) => void typeLive($, value),
    submitLive: () => void submitLive($),
    copyAttach: () => void copyAttach($),
    openTerminal: () => void openTerminal($),
    signOut: () =>
      void (async () => {
        const d = await read($, dialog)
        if (d?.kind !== 'signIn') return
        const host = (await read($, view)).hosts.find((known) => known.id === d.hostId)
        const running =
          host?.accounts.find((a) => a.account.name === d.account)?.sessions.filter((s) => s.running).length ?? 0
        await openDialog($, await confirmDialog($, { kind: 'signOut', hostId: d.hostId, account: d.account, running }))
      })(),
  }
}

/** The hosts as text, for `/remote-control-cli-servers text` and where panes don't draw. */
function summarize(current: ConductorView): string {
  return current.hosts
    .flatMap((host) => [
      `${host.label}${host.info ? ` (server ${host.info.serverVersion})` : ''}${host.error ? `: ${host.error}` : ''}`,
      ...host.accounts.flatMap((a) => [
        `  ${a.account.name}${a.account.account?.email ? ` <${a.account.account.email}>` : ''}${a.account.signedIn ? '' : ' (signed out)'}`,
        ...a.sessions.map((s) => `    ${s.running ? (s.waiting ? '◐' : '●') : '○'} ${sessionTitle(s)}`),
      ]),
    ])
    .join('\n')
}

async function openPane($: Engine) {
  await $.ui.open({ id: PANE, title: 'CLI Servers' })
  await update($, paneOpen, () => true)
  void refresh($)
}

async function closePane($: Engine) {
  await $.ui.close({ id: PANE })
  await update($, paneOpen, () => false)
}

/** Settings: the band above the prompt on or off, kept for every session on this Mac. */
async function setBand($: Engine, isOn: boolean) {
  await $.store.set('band', isOn)
  await update($, bandOn, () => isOn)
  await patchDialog($, 'settings', { isBandOn: isOn })
  void refresh($)
}

/** Demo mode on or off: made-up hosts, for screenshots. */
async function setDemo($: Engine, isOn: boolean) {
  await $.store.set('demo', isOn)
  await patchDialog($, 'settings', { isDemo: isOn })
  await refresh($)
}

async function openSettings($: Engine) {
  await openDialog($, { kind: 'settings', isBandOn: await read($, bandOn), isDemo: await isDemo($) })
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'remote-control-cli-servers',
      description: "Your Linux hosts' Claude accounts and sessions, in a pane",
      argumentHint: '[text | pair | demo]',
    })
    await registerTools($)
    const isBandOn = (await $.store.get('band')) !== false
    await update($, bandOn, () => isBandOn)
    // One timer for the session's life, started on every load (a hot reload drops the last one);
    // it reads the hosts only while the pane is open.
    ticker?.cancel()
    ticker = $.clock.every(TICK_MS, () => void tick($))
    return next(e)
  })

  on('command.run', { command: 'remote-control-cli-servers' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'text') {
      await refresh($)
      return { text: summarize(await read($, view)) || 'No hosts are paired yet: /remote-control-cli-servers pair pairs one.' }
    }
    if (args === 'demo') {
      const isOn = !(await isDemo($))
      await setDemo($, isOn)
      await openPane($)
      return {
        text: isOn
          ? 'Demo mode on: made-up hosts, profiles and sessions, for screenshots. Nothing reaches a real host. /remote-control-cli-servers demo again turns it off.'
          : 'Demo mode off: your hosts again.',
      }
    }
    await openPane($)
    if (args === 'pair') await openDialog($, { kind: 'pair', code: '', label: '', error: null, isBusy: false })
    return { text: 'CLI Servers opened.' }
  })

  // Only this plugin's own tools: it answers them itself, and sees no other tool's calls.
  on('tool.call', { tool: /^mcp__remote-control-cli-servers__/ }, async ($, e) => {
    try {
      const result = await runTool($, e.tool.slice(TOOL_PREFIX.length), e as unknown as ToolInput)
      return { result: JSON.stringify(result, (_, v) => (v === null ? undefined : v), 2) }
    } catch (err) {
      return { deny: errorText(err) }
    }
  })

  // Keys typed into the session window's region: numbered, so a repeat isn't sent twice.
  on('ui.message', { requestId: DIALOG, element: 'term' }, async ($, e) => {
    const posted = ((e.data as { keys?: Array<{ seq: number; key: WindowKey }> } | null)?.keys ?? []).filter(
      (p) => p.seq > typedUpTo,
    )
    if (posted.length > 0) {
      typedUpTo = Math.max(...posted.map((p) => p.seq))
      const upTo = typedUpTo
      typing = typing.then(async () => {
        await sendKeys($, mergeKeys(posted.map((p) => p.key)))
        await patchDialog($, 'window', { ack: upTo })
      })
      await typing
    }
    const d = await read($, dialog)
    if (d?.kind !== 'window') return {}
    return { props: { text: d.screen ? trimScreen(d.screen.text).slice(-9000) : '', ack: d.ack, isGone: d.isGone } }
  })

  // The pane closed by hand (Ctrl+X X) or by the band: the band's button opens it again.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    await update($, paneOpen, () => false)
    return next(e)
  })

  on('ui.close', { id: DIALOG }, async ($, e, next) => {
    await tidyDialog($)
    return next(e)
  })

  // The band above the prompt: the hosts in one line, beside any other plugin's band.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e)
    if (!(await read($, bandOn))) return next(e)
    const current = await read($, view)
    if (current.hosts.length === 0) return next(e)
    const ui = { ...$.ui.resolve(e), surface: e.surface } as Ui
    const ours = Band(ui, bandModel(current.hosts), e.props.bodyColumns, await read($, paneOpen), {
      open: () => void openPane($),
      close: () => void closePane($),
      answer: (only) => void openWindowDialog($, only.target, only.windowId, null),
    })
    const theirs = await next(e)
    if (!theirs) return ours
    const { Box } = ui
    return (
      <Box flexDirection="column">
        {theirs}
        {ours}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text>{summarize(await read($, view))}</Text>
    }
    const ui = { ...$.ui.resolve(e), surface: e.surface } as Ui
    return Overview(
      ui,
      {
        view: await read($, view),
        selected: await read($, selected),
        archived: await read($, archived),
        showAll: await read($, showAll),
        busy: await read($, busy),
        note: await read($, note),
        openMenu: await read($, openMenu),
        now: await $.clock.now(),
        columns: e.props.bodyColumns ?? e.viewport?.columns ?? 80,
      },
      viewActions($),
    )
  })

  on('ui.render', { component: 'Pane', requestId: DIALOG }, async ($, e) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)
      return <Text>Open this in the terminal or the Claude desktop app.</Text>
    }
    const ui = { ...$.ui.resolve(e), surface: e.surface } as Ui
    const d = await read($, dialog)
    if (!d) {
      const { Text } = ui
      return <Text dimColor>Nothing to show.</Text>
    }
    const regionProps = windowRegionProps(d, e.surface)
    if (!regionProps) return Dialog(ui, d, await read($, view), dialogActions($), null)
    // The tmux window's live region, in the terminal: one call with the surface module's fixed path,
    // straight off the resolved table, so the directory reads the path where the element is made.
    const region = $.ui.resolve(e).Client({ key: 'term', module: './terminal.tsx', props: regionProps })
    return Dialog(ui, d, await read($, view), dialogActions($), region)
  })
}
