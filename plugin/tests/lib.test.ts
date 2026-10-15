import type { HostInfo, LaunchResult, RcServer, RemoteAccount, RemoteSession, TransferPlan } from '../hooks/lib/wire'

import { describe, expect, test } from 'claude-code/testing'

import { RemoteError, readCurl, serverError, splitStatus } from '../hooks/lib/curl'
import {
  accountLine,
  formatBytes,
  relativeTime,
  sessionTitle,
  shortenHome,
  signInLeft,
  stampToIso,
} from '../hooks/lib/format'
import { addressOrder, findHost, mergeHosts, parseHostList } from '../hooks/lib/hosts'
import { bandDetail, bandModel, bandParts } from '../hooks/lib/band'
import { liveEdit, mergeKeys, textKeys, trimScreen, windowKeyFor } from '../hooks/lib/keys'
import { mcpCall, mcpResult, openedWhere } from '../hooks/lib/mac-app'
import { automaticMemory, memoryDecisions, planSummary, progressId } from '../hooks/lib/move'
import { accountNameHint, isValidAccountName, isValidSessionName, suffixProblem } from '../hooks/lib/names'
import { decodeBase64Url, decodePairingCode, formatFingerprint } from '../hooks/lib/pairing'
import { findSession, splitProfile } from '../hooks/lib/refs'
import { isMacHost } from '../hooks/lib/mac-host'
import { groupByServer, servingServer } from '../hooks/lib/served'
import { launchNote, launchTitle, signOutBody, switchEffect } from '../hooks/lib/texts'
import { sessionJson, toolDecisions } from '../hooks/lib/tools'

const NOW = Date.parse('2026-10-02T12:00:00Z')

const base64url = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

describe('pairing', () => {
  const body = { v: 1, hosts: ['100.1.1.1:7443', 'orion:7443'], secret: 's3cret', fp: 'ab'.repeat(32) }

  test('reads a code, whitespace and all', () => {
    expect(decodePairingCode(`aip1.${base64url(JSON.stringify(body))}`)).toEqual({
      hosts: body.hosts,
      secret: 's3cret',
      fingerprint: 'ab'.repeat(32),
    })
    expect(decodePairingCode(`  aip1.${base64url(JSON.stringify(body)).replace(/(.{10})/g, '$1\n')}`)).toEqual({
      hosts: body.hosts,
      secret: 's3cret',
      fingerprint: 'ab'.repeat(32),
    })
  })

  test('says what is wrong with anything else', () => {
    expect(decodePairingCode('')).toEqual({ error: '' })
    expect(decodePairingCode('hello')).toEqual({ error: "That isn't a pairing code: it starts with aip1." })
    expect(decodePairingCode('aip1.!!!')).toEqual({ error: 'That pairing code is damaged: copy it again.' })
    expect(decodePairingCode(`aip1.${base64url(JSON.stringify({ ...body, v: 2 }))}`)).toEqual({
      error: 'That pairing code is damaged: copy it again.',
    })
    expect(decodePairingCode(`aip1.${base64url(JSON.stringify({ ...body, fp: 'XY' }))}`)).toEqual({
      error: 'That pairing code is damaged: copy it again.',
    })
  })

  test('decodes base64url, and formats fingerprints as the server prints them', () => {
    expect(decodeBase64Url(base64url('héllo'))).toBe('héllo')
    expect(formatFingerprint('ab01')).toBe('AB:01')
  })
})

describe('format', () => {
  test('bytes, times and paths', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(3.4 * 1024 * 1024)).toBe('3.4 MB')
    expect(formatBytes(74 * 1024 * 1024)).toBe('74 MB')
    expect(relativeTime('2026-10-02T11:59:50Z', NOW)).toBe('just now')
    expect(relativeTime('2026-10-02T11:30:00Z', NOW)).toBe('30 min ago')
    expect(relativeTime('2026-09-29T12:00:00Z', NOW)).toBe('3 d ago')
    expect(shortenHome('/home/m/brain', '/home/m')).toBe('~/brain')
    expect(shortenHome('/home/m', '/home/m')).toBe('~')
    expect(shortenHome('/home/mx', '/home/m')).toBe('/home/mx')
    expect(stampToIso('20261002-142535')).toBe('2026-10-02T14:25:35')
  })

  test('sign-in time left and the account line', () => {
    expect(signInLeft('2026-10-20T12:00:00Z', NOW)).toBe('18 days left')
    expect(signInLeft('2026-10-02T13:00:00Z', NOW)).toBe('less than 2 hours left')
    expect(signInLeft('2026-10-01T00:00:00Z', NOW)).toBe('expired')
    const account = {
      name: 'Misc',
      signedIn: true,
      signedInUntil: '2026-10-03T12:00:00Z',
      account: { email: 'a@b.c', name: null, organization: null, plan: 'Max' },
    } as RemoteAccount
    expect(accountLine(account, NOW)).toBe('a@b.c · Max · 24 hours left')
    expect(accountLine({ ...account, signedIn: false }, NOW)).toBe('signed out')
  })

  test('a session is called by its title, last prompt or id', () => {
    expect(sessionTitle({ id: 'abcdef123', title: ' T ', lastPrompt: 'p' })).toBe('T')
    expect(sessionTitle({ id: 'abcdef123', title: null, lastPrompt: 'p' })).toBe('p')
    expect(sessionTitle({ id: 'abcdef123', title: null, lastPrompt: null })).toBe('abcdef12')
  })
})

describe('names', () => {
  test('account names', () => {
    expect(isValidAccountName('work_2')).toBe(true)
    expect(isValidAccountName('-x')).toBe(false)
    expect(isValidAccountName('Default')).toBe(false)
    expect(accountNameHint('Misc', 'orion', ['misc'])).toEqual({
      text: 'orion already has a profile called Misc.',
      problem: true,
    })
    expect(accountNameHint('work', 'orion', [])).toEqual({
      text: 'On orion: ~/.claude-accounts/work',
      problem: false,
    })
  })

  test('session names and suffixes', () => {
    expect(isValidSessionName('Deploy')).toBe(true)
    expect(isValidSessionName('-x')).toBe(false)
    expect(isValidSessionName('  ')).toBe(false)
    expect(suffixProblem('xJOPA')).toBe(null)
    expect(suffixProblem('a(b)')).toBe('No brackets: they are added around it.')
  })
})

describe('curl', () => {
  const run = (exitCode: number, stdout = '', stderr = '') => ({ exitCode, stdout, stderr })

  test('answers JSON, or null to try the next address', () => {
    expect(splitStatus('{"a":1}\n200')).toEqual({ status: 200, body: '{"a":1}' })
    expect(readCurl(run(0, '{"ok":true}\n200'), true)).toEqual({ ok: true })
    expect(readCurl(run(0, '\n204'), false)).toEqual({})
    expect(readCurl(run(7), false)).toBe(null)
    expect(readCurl(run(28), true)).toBe(null)
  })

  test("doesn't retry a write that may have reached the host", () => {
    expect(() => readCurl(run(28), false)).toThrow('The host took too long to answer.')
  })

  test('throws the server error with its code', () => {
    let caught: unknown
    try {
      readCurl(run(0, '{"error":{"code":"window_gone","message":"That window has closed."}}\n404'), true)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(RemoteError)
    expect((caught as RemoteError).code).toBe('window_gone')
    expect(() => readCurl(run(90), true)).toThrow("The host's certificate doesn't match the pairing.")
    expect(() => readCurl(run(4, '', 'This Mac has no token for that host: pair it again.\n'), true)).toThrow(
      'This Mac has no token for that host: pair it again.',
    )
    expect(serverError(502, 'Bad gateway').message).toBe('HTTP 502 Bad gateway')
  })
})

describe('hosts', () => {
  const host = { id: 'h1', label: 'orion', hostname: 'orion', addresses: ['a:1', 'b:1'], fingerprint: 'f' }

  test('reads the app list and merges it under the plugin one', () => {
    expect(parseHostList(JSON.stringify({ hosts: [{ ...host, profiles: {} }, { id: 'x' }] }))).toEqual([
      { ...host, clientId: undefined, pairedAt: undefined, lastGoodAddress: null },
    ])
    const other = { ...host, id: 'h2', label: 'ONE' }
    expect(mergeHosts([host], [host, other], []).map((h) => h.id)).toEqual(['h1', 'h2'])
    expect(mergeHosts([host], [other], ['h2']).map((h) => h.id)).toEqual(['h1'])
  })

  test('addresses and names', () => {
    expect(addressOrder({ ...host, lastGoodAddress: 'b:1' })).toEqual(['b:1', 'a:1'])
    expect(findHost([host], 'ORION')).toEqual(host)
    expect(findHost([host], 'nas')).toEqual({ error: 'No host is called "nas". Paired hosts: orion.' })
  })
})

describe('references', () => {
  const sessions = [
    { id: '4547caf0-d10a-4b93-b9e9-ab8f01ac1f2c', title: 'Deploy', lastPrompt: null },
    { id: '4547caf1-0000-4000-8000-000000000000', title: 'Two', lastPrompt: null },
  ]

  test('host/account, and sessions by id, prefix or title', () => {
    expect(splitProfile('orion/Misc')).toEqual({ host: 'orion', account: 'Misc' })
    expect(splitProfile('Misc')).toEqual({ error: '"Misc" names no account: write it as host/account.' })
    expect(findSession(sessions, '4547caf0-d10a')).toEqual(sessions[0])
    expect(findSession(sessions, 'deploy')).toEqual(sessions[0])
    expect(findSession(sessions, '4547caf')).toEqual({
      error: 'No session is called "4547caf". Sessions here: Deploy, Two.',
    })
  })
})

describe('moves', () => {
  const plan = {
    items: [
      { path: 'a', action: 'copy' },
      { path: 'b', action: 'replace' },
      { path: 'c', action: 'same' },
    ],
    memory: [
      { path: 'x.md', action: 'conflict', newer: 'destination', sourceText: 's', destinationText: 'd' },
      { path: 'y.md', action: 'add', newer: 'source', sourceText: null, destinationText: null },
    ],
  } as TransferPlan

  test('summarises the plan', () => {
    expect(planSummary(plan)).toBe(
      'Files: 1 to copy, 1 to replace, 1 already there. What it replaces or removes is backed up first.',
    )
    expect(automaticMemory(plan)).toEqual(['add    memory/y.md'])
  })

  test('decides each conflict, the newer side by default', () => {
    expect(memoryDecisions(plan, {}, {})).toEqual({ 'x.md': { take: 'destination' } })
    expect(memoryDecisions(plan, { 'x.md': 'source' }, {})).toEqual({ 'x.md': { take: 'source' } })
    expect(memoryDecisions(plan, { 'x.md': 'merged' }, { 'x.md': 'both' })).toEqual({
      'x.md': { take: 'merged', text: 'both' },
    })
    expect(progressId(() => 0)).toBe('00000000-0000-4000-a000-000000000000')
  })

  test("the tools' decisions", () => {
    const newer = () => 'source' as const
    expect(toolDecisions({ 'x.md': 'newer' }, ['x.md'], newer)).toEqual({ decisions: { 'x.md': { take: 'source' } } })
    expect(toolDecisions({ 'x.md': { merged: 't' } }, ['x.md'], newer)).toEqual({
      decisions: { 'x.md': { take: 'merged', text: 't' } },
    })
    expect(toolDecisions({}, ['x.md'], newer)).toEqual({
      error:
        'Both sides changed these memory notes, and each needs a decision in memory ("source", "destination", "newer", or {"merged": "..."}): x.md.',
    })
    expect(toolDecisions({ 'z.md': 'source' }, [], newer)).toEqual({
      error: "These aren't memory conflicts in this move: z.md. plan_move lists the ones that are.",
    })
  })
})

describe('texts and keys', () => {
  const launch = {
    window: { session: 'ai', windowId: '@9', paneId: '%9' },
    alreadyRunning: false,
    sessionId: null,
    remoteControlName: 'Deploy (xJOPA)',
    attention: null,
    attachCommand: '',
  } as LaunchResult

  test('launch titles and notes', () => {
    expect(launchTitle(launch)).toBe('Session started')
    expect(launchTitle({ ...launch, attention: { kind: 'waiting', text: '' } })).toBe('Started, and waiting')
    expect(launchNote(launch, null)).toBe(
      'Remote Control is on as "Deploy (xJOPA)", so it\'s in the Claude app on your other devices.',
    )
    expect(launchNote(launch, { text: '', width: 1, height: 1, sessionId: 'x', remoteControl: false })).toBe(
      'Claude is running. Remote Control is connecting…',
    )
  })

  test('sign-out and switch wording', () => {
    expect(signOutBody(0)).toBe('Its sessions are kept. Sign in again to use them.')
    expect(signOutBody(2)).toContain('2 sessions are running. They stop first')
    expect(switchEffect(1)).toContain('Its 1 session stops, and resumes')
  })

  test('window keys and screens', () => {
    expect(textKeys('hi', true)).toEqual([{ text: 'hi' }, { key: 'Enter' }])
    expect(textKeys('', true)).toEqual([{ key: 'Enter' }])
    expect(trimScreen('a   \nb  \n\n\n')).toBe('a\nb')
  })

  test('sessions as the tools report them', () => {
    const s = {
      id: 'x',
      title: 'T',
      lastPrompt: null,
      cwd: '/a',
      updatedAt: 'u',
      running: true,
      remoteControl: true,
      bridgeSessionId: 'session_1',
      sizeBytes: 1,
      window: { session: 'ai', windowId: '@1', paneId: '%1' },
    } as RemoteSession
    expect(sessionJson(s)).toEqual({
      id: 'x',
      title: 'T',
      folder: '/a',
      updated: 'u',
      running: true,
      remoteControl: true,
      link: 'https://claude.ai/code/session_1',
      window: '@1',
      sizeBytes: 1,
      waitingForInput: undefined,
      claudeVersion: undefined,
      updatePending: undefined,
      installedVersion: undefined,
      empty: undefined,
    })
  })
})

describe('typing into a window', () => {
  test('keys map to what tmux takes', () => {
    expect(windowKeyFor({ key: 'return' })).toEqual({ key: 'Enter' })
    expect(windowKeyFor({ key: 'tab', shift: true })).toEqual({ key: 'BTab' })
    expect(windowKeyFor({ key: 'c', ctrl: true })).toEqual({ key: 'C-c' })
    expect(windowKeyFor({ key: 'x', ctrl: true })).toBe(null)
    expect(windowKeyFor({ key: 'v', meta: true })).toBe(null)
    expect(windowKeyFor({ key: ' ' })).toEqual({ key: 'Space' })
    expect(windowKeyFor({ key: 'é' })).toEqual({ text: 'é' })
  })

  test('runs of text go as one', () => {
    expect(mergeKeys([{ text: 'h' }, { text: 'i' }, { key: 'Enter' }, { text: '!' }])).toEqual([
      { text: 'hi' },
      { key: 'Enter' },
      { text: '!' },
    ])
  })
})

describe('the Mac app', () => {
  test('one MCP call, and its answer', () => {
    const lines = mcpCall('open_in_claude', { profile: 'orion/Misc', session: 'abc' }).trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).method)).toEqual(['initialize', 'notifications/initialized', 'tools/call'])
    const out = [
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"{\\"openedIn\\":\\"Claude (Work)\\"}"}]}}',
    ].join('\n')
    expect(mcpResult(out)).toEqual({ text: '{"openedIn":"Claude (Work)"}', isError: false })
    expect(openedWhere('{"openedIn":"Claude (Work)"}')).toEqual({ app: 'Claude (Work)', note: null })
    expect(mcpResult('{"jsonrpc":"2.0","id":2,"error":{"message":"nope"}}')).toEqual({ text: 'nope', isError: true })
    expect(mcpResult('garbage')).toBe(null)
  })
})

describe('live typing', () => {
  test('each change becomes the keys that make it', () => {
    expect(liveEdit('', 'ls')).toEqual([{ text: 'ls' }])
    expect(liveEdit('ls', 'ls -la')).toEqual([{ text: ' -la' }])
    expect(liveEdit('ls -la', 'ls')).toEqual([{ key: 'BSpace' }, { key: 'BSpace' }, { key: 'BSpace' }, { key: 'BSpace' }])
    expect(liveEdit('cat a', 'cat b')).toEqual([{ key: 'BSpace' }, { text: 'b' }])
    expect(liveEdit('same', 'same')).toEqual([])
  })
})

describe('the band', () => {
  const host = (label: string, sessions: Array<{ running: boolean; waiting?: boolean }>, error: string | null = null) =>
    ({
      id: label,
      label,
      hostname: label,
      address: null,
      info: null,
      error,
      accounts: [
        {
          account: { name: 'main' },
          error: null,
          sessions: sessions.map((s, i) => ({
            id: `${label}-${i}`,
            title: `${label} ${i}`,
            lastPrompt: null,
            window: { session: 'ai', windowId: `@${i}`, paneId: `%${i}` },
            ...s,
          })),
        },
      ],
    }) as never

  test('counts, the one waiting session, and how much fits', () => {
    const model = bandModel([
      host('atlas', [{ running: true }, { running: true, waiting: true }, { running: false }]),
      host('nebula', [{ running: true }]),
      host('homelab', [], 'Not answering.'),
    ])
    expect(model.waiting).toBe(1)
    expect(model.offline).toBe(1)
    expect(model.only?.target).toEqual({ hostId: 'atlas', account: 'main', sessionId: 'atlas-1', title: 'atlas 1' })
    expect(model.only?.windowId).toBe('@1')
    const text = (detail: 'full' | 'names' | 'totals') =>
      bandParts(model, detail)
        .map((p) => p.text)
        .join('')
    expect(text('full')).toBe('1 waiting · ATLAS ● 2 ◐ 1 · NEBULA ● 1 · HOMELAB offline')
    expect(text('names')).toBe('1 waiting · ATLAS ◐ · NEBULA ● · HOMELAB ○')
    expect(text('totals')).toBe('1 waiting · 1 offline')
    expect(bandDetail(model, 120)).toBe('full')
    expect(bandDetail(model, 60)).toBe('names')
    expect(bandDetail(model, 30)).toBe('totals')
  })

  test('nothing waiting, and two waiting', () => {
    const quiet = bandModel([host('atlas', [{ running: true }])])
    expect(quiet.only).toBeNull()
    expect(bandParts(quiet, 'totals').map((p) => p.text)).toEqual(['1 host, nothing waiting'])
    const two = bandModel([host('atlas', [{ running: true, waiting: true }, { running: true, waiting: true }])])
    expect(two.waiting).toBe(2)
    expect(two.only, 'the button opens the pane when more than one waits').toBeNull()
  })
})

describe('sessions a Remote Control server serves', () => {
  const server = (pid: number, folder: string): RcServer => ({
    pid,
    folder,
    name: null,
    spawn: 'same-dir',
    sessions: 0,
    window: null,
    environmentUrl: null,
    attention: null,
  })
  const session = (id: string, cwd: string, over: Partial<RemoteSession> = {}): RemoteSession => ({
    id,
    cwd,
    title: id,
    named: false,
    lastPrompt: null,
    updatedAt: '2026-10-02T12:00:00Z',
    sizeBytes: 0,
    running: true,
    window: null,
    remoteControl: true,
    ...over,
  })

  test('served sessions go under their server; the CLI ones and stopped ones stay apart', () => {
    const servers = [server(1, '/www/vb4'), server(2, '/www/vb4/sub')]
    const sessions = [
      session('cli', '/www/vb4'),
      session('served', '/www/vb4', { served: true }),
      session('worktree', '/www/vb4/.claude/worktrees/a1', { served: true }),
      session('nested', '/www/vb4/sub', { served: true }),
      session('stopped', '/www/vb4', { served: true, running: false }),
      session('sibling', '/www/vb40', { served: true }),
    ]
    const { byServer, rest } = groupByServer(sessions, servers)
    expect(byServer.get(1)?.map((s) => s.id)).toEqual(['served', 'worktree'])
    expect(byServer.get(2)?.map((s) => s.id), 'the deepest folder wins').toEqual(['nested'])
    expect(
      rest.map((s) => s.id),
      'a served session with no server listed is still shown',
    ).toEqual(['cli', 'stopped', 'sibling'])
  })

  test('no servers, or none known yet', () => {
    const served = session('served', '/www/vb4', { served: true })
    expect(servingServer(served, [])).toBeUndefined()
    expect(groupByServer([served], null).rest).toEqual([served])
  })
})

describe('mac host', () => {
  test('a shared Mac is known by its version', () => {
    const info = (serverVersion: string) => ({ serverVersion }) as HostInfo
    expect(isMacHost(info('0.7.0 (Mac)'))).toBe(true)
    expect(isMacHost(info('0.10.2'))).toBe(false)
    expect(isMacHost(null)).toBe(false)
  })
})
