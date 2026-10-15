// Demo mode (`/remote-control-cli-servers demo`): three made-up hosts, their profiles and
// sessions, for screenshots. Every request to a demo host is answered here,
// so nothing reaches the network and nothing real changes.

import type { PairedHost } from './hosts'
import type {
  ArchivedSession,
  DirListing,
  HostInfo,
  LaunchResult,
  RcServer,
  RemoteAccount,
  RemoteSession,
  TransferPlan,
  WindowScreen,
} from './wire'

import { RemoteError } from './curl'

const HOUR = 3_600_000
const DAY = 24 * HOUR

type DemoHost = PairedHost & {
  info: HostInfo
  accounts: Array<{ account: RemoteAccount; sessions: Array<RemoteSession>; servers?: Array<RcServer> }>
}

/** A Remote Control server, started from here in a window of its own. */
function server(pid: number, folder: string, name: string, spawn: string, sessions: number): RcServer {
  return {
    pid,
    folder,
    name,
    spawn,
    sessions,
    window: { session: 'ai', windowId: `@${pid % 100}`, paneId: `%${pid % 100}` },
    environmentUrl: `https://claude.ai/code?environment=env_demo${pid}`,
    attention: null,
  }
}

const ago = (now: number, ms: number) => new Date(now - ms).toISOString()
const until = (now: number, ms: number) => new Date(now + ms).toISOString()

let counter = 0
const id = (n: number) => `de300000-0000-4000-8000-${String(n).padStart(12, '0')}`

function session(
  now: number,
  title: string,
  cwd: string,
  updated: number,
  over: Partial<RemoteSession> = {},
): RemoteSession {
  counter += 1
  const window = over.running ? { session: 'ai', windowId: `@${counter + 10}`, paneId: `%${counter + 10}` } : null
  return {
    id: id(counter),
    cwd,
    title,
    named: true,
    lastPrompt: null,
    updatedAt: ago(now, updated),
    sizeBytes: 180_000 * counter,
    running: false,
    window,
    remoteControl: Boolean(over.running),
    bridgeSessionId: over.running ? `session_01Demo${counter}` : null,
    claudeVersion: over.running ? '2.1.290' : null,
    ...over,
  }
}

function account(name: string, email: string | null, plan: string | null, left: number, now: number): RemoteAccount {
  return {
    name,
    isDefault: false,
    configDir: `/home/sam/.claude-accounts/${name}`,
    account: email ? { email, name: 'Sam Lee', organization: null, plan } : null,
    signedIn: email !== null,
    signedInUntil: email ? until(now, left) : null,
    sessions: 0,
    runningSessions: 0,
  }
}

function info(hostname: string, claude: string, tmux: string, suffix: string | null): HostInfo {
  return {
    hostname,
    home: '/home/sam',
    serverVersion: '0.6.3',
    apiVersion: 1,
    tmux: { version: tmux, session: 'ai' },
    claude: { path: '/home/sam/.local/bin/claude', version: `${claude} (Claude Code)` },
    accountsBase: '/home/sam/.claude-accounts',
    includesDefault: false,
    settings: { remoteControlSuffix: suffix },
  }
}

/** The demo hosts, with everything they answer. */
export function demoHosts(now: number): Array<DemoHost> {
  counter = 0
  const outdated = { claudeVersion: '2.1.288', updatePending: true, installedVersion: '2.1.290' }
  const hosts: Array<DemoHost> = [
    {
      id: 'demo-atlas',
      label: 'atlas',
      hostname: 'atlas',
      addresses: ['100.64.0.11:7443'],
      fingerprint: '0'.repeat(64),
      lastGoodAddress: '100.64.0.11:7443',
      info: info('atlas', '2.1.290', '3.4', 'ATL'),
      accounts: [
        {
          account: account('work', 'sam@northwind.dev', 'Max', 21 * DAY, now),
          sessions: [
            session(now, 'API gateway (ATL)', '/home/sam/northwind/gateway', 12 * 60_000, {
              running: true,
              ...outdated,
            }),
            session(now, 'Billing migration (ATL)', '/home/sam/northwind/billing', 40 * 60_000, { running: true }),
            session(now, 'Search tuning (ATL)', '/home/sam/northwind/search', 3 * 60_000, {
              running: true,
              waiting: true,
              remoteControl: false,
              bridgeSessionId: null,
            }),
            session(now, 'docs-site', '/home/sam/northwind/docs', 3 * DAY),
            session(now, 'flaky-tests', '/home/sam/northwind/ci', 12 * DAY),
            session(now, 'northwind-4f', '/home/sam/northwind/.claude/worktrees/4f', 8 * 60_000, {
              running: true,
              served: true,
            }),
            session(now, 'northwind-a2', '/home/sam/northwind/.claude/worktrees/a2', 30 * 60_000, {
              running: true,
              served: true,
              empty: true,
            }),
          ],
          servers: [server(4121, '/home/sam/northwind', 'northwind (ATL)', 'worktree', 2)],
        },
        {
          account: account('personal', 'sam.lee@fastmail.com', 'Pro', 9 * DAY, now),
          sessions: [
            session(now, 'Garden planner (ATL)', '/home/sam/garden', 2 * HOUR, { running: true }),
            session(now, 'photo-sorter', '/home/sam/photos', 6 * DAY),
          ],
        },
        { account: account('client-acme', null, null, 0, now), sessions: [] },
      ],
    },
    {
      id: 'demo-nebula',
      label: 'nebula',
      hostname: 'nebula',
      addresses: ['100.64.0.12:7443'],
      fingerprint: '1'.repeat(64),
      lastGoodAddress: '100.64.0.12:7443',
      info: info('nebula', '2.1.290', '3.4', null),
      accounts: [
        {
          account: account('research', 'sam@northwind.dev', 'Max', 21 * DAY, now),
          sessions: [
            session(now, 'Model eval harness', '/home/sam/evals', 5 * 60_000, {
              running: true,
              remoteControlConnecting: true,
              bridgeSessionId: null,
            }),
            session(now, 'Dataset cleanup', '/home/sam/data', 50 * 60_000, { running: true }),
            session(now, 'paper-notes', '/home/sam/notes', 2 * DAY),
          ],
        },
      ],
    },
    {
      id: 'demo-homelab',
      label: 'homelab',
      hostname: 'homelab',
      addresses: ['100.64.0.13:7443'],
      fingerprint: '2'.repeat(64),
      lastGoodAddress: '100.64.0.13:7443',
      info: info('homelab', '2.1.290', '3.3a', 'HL'),
      accounts: [
        {
          account: account('home', 'sam.lee@fastmail.com', 'Pro', 9 * DAY, now),
          sessions: [
            session(now, 'Automations (HL)', '/home/sam/home-assistant', 25 * 60_000, { running: true, ...outdated }),
            session(now, 'Grafana dashboards', '/home/sam/grafana', 4 * DAY),
          ],
        },
      ],
    },
  ]
  for (const host of hosts) {
    for (const a of host.accounts) {
      a.account.sessions = a.sessions.length
      a.account.runningSessions = a.sessions.filter((s) => s.running).length
    }
  }
  return hosts
}

/** Whether a host is one of the demo's. */
export function isDemoHost(hostId: string): boolean {
  return hostId.startsWith('demo-')
}

const SCREEN = [
  ' ✻ Welcome to Claude Code',
  '',
  '   /home/sam/northwind/search',
  '',
  ' Do you trust the files in this folder?',
  '',
  ' Claude Code may read, write or run files here.',
  '',
  ' ❯ 1. Yes, proceed',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to exit',
].join('\n')

function launch(windowId: string, name: string): LaunchResult {
  return {
    window: { session: 'ai', windowId, paneId: windowId.replace('@', '%') },
    alreadyRunning: false,
    sessionId: id(99),
    remoteControlName: name,
    attention: null,
    attachCommand: `tmux attach -t ai ; select-window -t ${windowId}`,
  }
}

/** What a demo host answers to `method path`. */
export function demoAnswer(hostId: string, method: string, url: string, body: unknown, now: number): unknown {
  const host = demoHosts(now).find((h) => h.id === hostId)
  if (!host) throw new RemoteError('not_found', 'No such demo host.')
  const [path = '', query = ''] = url.split('?')
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
  const find = (name: string | undefined) => host.accounts.find((a) => a.account.name === name)
  const reject = () => {
    throw new RemoteError('not_found', 'No such route.')
  }
  if (method === 'GET' && path === '/v1/info') return host.info
  if (method === 'GET' && path === '/v1/accounts') return host.accounts.map((a) => a.account)
  if (method === 'GET' && path === '/v1/fs/dirs') {
    const at = new URLSearchParams(query).get('path') ?? '/home/sam'
    const listing: DirListing = {
      path: at,
      parent: at === '/home/sam' ? null : at.split('/').slice(0, -1).join('/') || '/',
      home: '/home/sam',
      entries: ['northwind', 'garden', 'photos', 'notes', 'scripts'].map((name) => ({ name, path: `${at}/${name}` })),
      truncated: false,
    }
    return listing
  }
  if (parts[1] === 'accounts' && parts[3] === 'sessions' && parts.length === 4) {
    const a = find(parts[2]) ?? reject()
    if (method === 'GET') return a?.sessions
    const name = (body as { name?: string } | undefined)?.name ?? 'New session'
    return launch(
      '@40',
      host.info.settings?.remoteControlSuffix ? `${name} (${host.info.settings.remoteControlSuffix})` : name,
    )
  }
  if (parts[1] === 'accounts' && parts[3] === 'rc-servers') {
    const a = find(parts[2]) ?? reject()
    if (method === 'GET' && parts.length === 4) return a?.servers ?? []
    if (method === 'POST' && parts[5] === 'stop') return { wasRunning: true }
    if (method === 'POST' && parts.length === 4) {
      const request = body as { folder?: string; name?: string; spawn?: string }
      const folder = request.folder ?? '/home/sam'
      return {
        server: server(4200, folder, request.name ?? folder.split('/').pop() ?? 'demo', request.spawn ?? 'same-dir', 0),
        alreadyRunning: false,
        attachCommand: 'tmux attach -t ai \\; select-window -t @0',
      }
    }
  }
  if (parts[1] === 'accounts' && parts[3] === 'archived' && method === 'GET') {
    const archived: Array<ArchivedSession> = [
      {
        id: id(90),
        archive: '20260921-091500-archived',
        stamp: '20260921-091500',
        title: 'Old prototype',
        cwd: '/home/sam/proto',
        sizeBytes: 2_400_000,
      },
      {
        id: id(91),
        archive: '20260914-160200-archived',
        stamp: '20260914-160200',
        title: 'Spike: websockets',
        cwd: '/home/sam/spikes',
        sizeBytes: 870_000,
      },
    ]
    return archived
  }
  if (parts[1] === 'accounts' && parts[3] === 'windows') {
    const screen: WindowScreen = { text: SCREEN, width: 80, height: 24, sessionId: null, remoteControl: false }
    return screen
  }
  if (parts[1] === 'accounts' && parts[3] === 'sessions' && parts[5] === 'transfer' && method === 'GET') {
    const from = parts[2] ?? ''
    const to = new URLSearchParams(query).get('to') ?? ''
    const plan: TransferPlan = {
      sessionId: parts[4] ?? '',
      source: from,
      destination: to,
      title: null,
      cwd: null,
      items: [
        { path: 'projects/session.jsonl', action: 'copy' },
        { path: 'file-history/1', action: 'copy' },
        { path: 'plans/rollout.md', action: 'same' },
      ],
      destinationNewer: false,
      memory: [
        { path: 'MEMORY.md', action: 'index', newer: 'source', sourceText: null, destinationText: null },
        {
          path: 'deploys.md',
          action: 'conflict',
          newer: 'source',
          sourceText: 'Deploy from main after CI.',
          destinationText: 'Deploy on Fridays only.',
        },
      ],
      running: [],
      archiveBytes: 1_200_000,
    }
    return plan
  }
  if (parts[1] === 'accounts' && (parts[5] === 'resume' || parts[5] === 'restart')) {
    const s = find(parts[2])?.sessions.find((x) => x.id === parts[4])
    return launch(s?.window?.windowId ?? '@41', s?.title ?? 'Session')
  }
  if (parts[1] === 'accounts' && parts[5] === 'stop') return { wasRunning: true }
  if (parts[1] === 'accounts' && parts[5] === 'archive') return { archivedTo: '/home/sam/.claude-accounts/archive' }
  if (parts[1] === 'accounts' && parts[3] === 'login') {
    return { loginId: id(98), url: 'https://claude.ai/oauth/authorize?demo=1', expiresAt: until(now, 10 * 60_000) }
  }
  if (method !== 'GET') return {}
  return reject()
}
