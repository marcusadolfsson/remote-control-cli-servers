// The plugin against a fake host: the scripts it runs (scripts/*.sh) are
// answered here (pinning, then each request by method and path), and the panes are
// mounted on the terminal and the desktop, so every tree is validated by both.

import type { On } from 'claude-code'

import { describe, expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-02T12:00:00Z')
const HOST_ID = '56d354fd-b7cd-47f4-8d41-5564fc7dbcdc'
const SURFACES = ['terminal', 'desktop'] as const

const session = (id: string, title: string, over: Record<string, unknown> = {}) => ({
  id,
  cwd: '/home/m/proj',
  title,
  named: true,
  lastPrompt: null,
  updatedAt: '2026-10-02T11:00:00Z',
  sizeBytes: 1000,
  running: false,
  window: null,
  remoteControl: false,
  ...over,
})

const RUNNING = session('11111111-1111-4111-8111-111111111111', 'Deploy (xJOPA)', {
  running: true,
  remoteControl: true,
  bridgeSessionId: 'session_01abc',
  window: { session: 'ai', windowId: '@7', paneId: '%7' },
  updatePending: true,
  claudeVersion: '2.1.282',
  installedVersion: '2.1.287',
})
const WAITING = session('22222222-2222-4222-8222-222222222222', 'Waiting one', {
  running: true,
  waiting: true,
  window: { session: 'ai', windowId: '@8', paneId: '%8' },
})
const STOPPED = session('33333333-3333-4333-8333-333333333333', 'Old work')

const ROUTES: Record<string, unknown> = {
  'GET /v1/info': {
    hostname: 'orion',
    home: '/home/m',
    serverVersion: '0.6.3',
    apiVersion: 1,
    tmux: { version: '3.4', session: 'ai' },
    claude: { path: '/usr/bin/claude', version: '2.1.287 (Claude Code)' },
    accountsBase: '/home/m/.claude-accounts',
    includesDefault: false,
    settings: { remoteControlSuffix: 'xJOPA' },
  },
  'GET /v1/accounts': [
    {
      name: 'Misc',
      isDefault: false,
      configDir: '/home/m/.claude-accounts/Misc',
      account: { email: 'm@example.com', name: null, organization: null, plan: 'Max' },
      signedIn: true,
      signedInUntil: '2026-10-20T00:00:00Z',
      sessions: 3,
      runningSessions: 2,
    },
    {
      name: 'Work',
      isDefault: false,
      configDir: '/home/m/.claude-accounts/Work',
      account: null,
      signedIn: false,
      sessions: 0,
      runningSessions: 0,
    },
  ],
  'GET /v1/accounts/Misc/sessions': [RUNNING, WAITING, STOPPED],
  'GET /v1/accounts/Work/sessions': [],
  'GET /v1/accounts/Misc/rc-servers': [
    {
      pid: 4121,
      folder: '/home/m/proj',
      name: 'proj (orion)',
      spawn: 'same-dir',
      sessions: 1,
      window: { session: 'ai', windowId: '@9', paneId: '%9' },
      environmentUrl: 'https://claude.ai/code?environment=env_01abc',
      attention: null,
    },
  ],
  'GET /v1/accounts/Work/rc-servers': [],
  'POST /v1/accounts/Misc/rc-servers/4121/stop': { wasRunning: true },
  'POST /v1/accounts/Misc/rc-servers': {
    server: {
      pid: 4122,
      folder: '/home/m',
      name: 'm (orion)',
      spawn: 'worktree',
      sessions: 0,
      window: { session: 'ai', windowId: '@10', paneId: '%10' },
      environmentUrl: 'https://claude.ai/code?environment=env_02abc',
      attention: null,
    },
    alreadyRunning: false,
    attachCommand: 'tmux attach -t ai',
  },
  'GET /v1/accounts/Misc/archived': [
    {
      id: '44444444-4444-4444-8444-444444444444',
      archive: '20261001-101010-archived',
      stamp: '20261001-101010',
      title: 'Archived one',
      cwd: '/home/m/x',
      sizeBytes: 2048,
    },
  ],
  'GET /v1/fs/dirs': {
    path: '/home/m',
    parent: '/home',
    home: '/home/m',
    entries: [{ name: 'proj', path: '/home/m/proj' }],
    truncated: false,
  },
  [`POST /v1/accounts/Misc/sessions/${STOPPED.id}/resume`]: {
    window: { session: 'ai', windowId: '@9', paneId: '%9' },
    alreadyRunning: false,
    sessionId: STOPPED.id,
    remoteControlName: 'Old work (xJOPA)',
    attention: null,
    attachCommand: 'tmux attach -t ai ; select-window -t @9',
  },
  [`POST /v1/accounts/Misc/sessions/${RUNNING.id}/stop`]: { wasRunning: true },
  [`GET /v1/accounts/Misc/sessions/${STOPPED.id}/transfer`]: {
    sessionId: STOPPED.id,
    source: 'Misc',
    destination: 'Work',
    title: 'Old work',
    cwd: '/home/m/proj',
    items: [{ path: 'projects/x.jsonl', action: 'copy' }],
    destinationNewer: false,
    memory: [{ path: 'notes.md', action: 'conflict', newer: 'source', sourceText: 'a', destinationText: 'b' }],
    running: [],
  },
  'GET /v1/accounts/Misc/windows/@8/screen': {
    text: 'Do you trust this folder?\n❯ 1. Yes\n  2. No',
    width: 80,
    height: 24,
    sessionId: null,
  },
  'POST /v1/accounts/Misc/windows/@8/keys': {
    text: 'Do you trust this folder?\n  1. Yes\n❯ 2. No',
    width: 80,
    height: 24,
    sessionId: null,
  },
  'POST /v1/accounts/Work/login': {
    loginId: 'aaaaaaaa-0000-4000-8000-000000000000',
    url: 'https://claude.ai/oauth/authorize?x=1',
    expiresAt: '2026-10-02T12:10:00Z',
  },
}

/** A pane's props as the surface hands them over (scroll and view left to the engine). */
const paneProps = (title: string, bodyColumns: number, placement: 'dock' | 'inline') =>
  ({ title, isFocused: true, bodyColumns, placement }) as never

const hostsText = { command: 'remote-control-cli-servers', args: 'text' } as never

const bandProps = (bodyColumns: number) => ({ hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns }) as never

/** Every request the plugin made, `METHOD /path`. */
type Calls = Array<string>

function fakeHost(on: On, calls: Calls) {
  mock.store(on)
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/Users/test' })
  on('fs.read', (_$, e) => {
    if (!e.path.endsWith('remote-hosts.json')) throw new Error(`unexpected read ${e.path}`)
    return {
      value: JSON.stringify({
        hosts: [
          {
            id: HOST_ID,
            label: 'orion',
            hostname: 'orion',
            addresses: ['100.1.1.1:7443'],
            fingerprint: 'ab'.repeat(32),
          },
        ],
      }),
    }
  })
  on('ui.status', () => ({ value: undefined }))
  // Beneath the plugin: no other band above the prompt.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return Box({ key: 'another-band' })
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.close', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    const ok = (stdout: string) => ({
      value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    const [, script = '', ...args] = e.argv
    if (script.endsWith('/scripts/pin.sh')) return ok('KEYHASH=\n')
    if (script.endsWith('/scripts/request.sh')) {
      const [, , url = '', method = 'GET'] = args
      const path = decodeURIComponent(new URL(url).pathname)
      calls.push(`${method} ${path}`)
      const answer = ROUTES[`${method} ${path}`]
      if (answer === undefined) return ok(`{"error":{"code":"not_found","message":"No such route."}}\n404`)
      return ok(`${JSON.stringify(answer)}\n200`)
    }
    return ok('')
  })
}

describe('the hosts pane', () => {
  test('/remote-control-cli-servers text lists every account and session', async ($, on) => {
    const calls: Calls = []
    fakeHost(on, calls)
    const { text } = await $.command.run(hostsText)
    expect(text).toContain('orion (server 0.6.3)')
    expect(text).toContain('Misc <m@example.com>')
    expect(text).toContain('◐ Waiting one')
    expect(text).toContain('Work (signed out)')
  })

  for (const surface of SURFACES) {
    test(`draws hosts, accounts and sessions on the ${surface}`, async ($, on) => {
      const calls: Calls = []
      fakeHost(on, calls)
      await $.command.run(hostsText)
      const ui = await $.ui.mount({
        plugin: 'remote-control-cli-servers',
        surface,
        component: 'Pane',
        requestId: 'conductor-hosts',
        props: paneProps('Hosts', 100, 'dock'),
      })
      expect(await ui.find({ key: `hm-${HOST_ID}` })).toBeDefined()
      expect(await ui.find({ key: `am-${HOST_ID}/Misc` })).toBeDefined()
      expect(await ui.find({ key: `sm-${RUNNING.id}` })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Waiting for you/ })).toBeDefined()
      // SVG icons where the desktop draws them; glyphs in the terminal, which draws no SVG.
      expect(await ui.find({ type: 'Svg' }), 'icons').toEqual(surface === 'desktop' ? expect.anything() : undefined)
      expect(await ui.find({ type: 'Text', text: /can update to 2\.1\.287/ })).toBeDefined()

      await ui.press({ key: `sm-${STOPPED.id}` })
      await ui.press({ key: `mi-sm-${STOPPED.id}-resume` })
      expect(calls).toContain(`POST /v1/accounts/Misc/sessions/${STOPPED.id}/resume`)
      expect(await ui.find({ type: 'Text', text: /Resumed Old work on orion/ })).toBeDefined()

      // A session's ⋯ opens its actions, each with its letter; one menu at a time.
      expect(await ui.find({ key: `mi-sm-${RUNNING.id}-stop` }), 'closed menu').toBeUndefined()
      await ui.press({ key: `sm-${RUNNING.id}` })
      expect(await ui.find({ key: `mi-sm-${RUNNING.id}-stop` }), 'open menu').toBeDefined()
      await ui.press({ key: `sm-${WAITING.id}` })
      expect(await ui.find({ key: `mi-sm-${RUNNING.id}-stop` }), 'the other menu closed').toBeUndefined()
      expect(await ui.find({ key: `mi-sm-${WAITING.id}-answer` }), 'this menu open').toBeDefined()
      await ui.press({ key: `sm-${WAITING.id}` })

      await ui.press({ key: `am-${HOST_ID}/Misc` })
      await ui.press({ key: `mi-am-${HOST_ID}/Misc-archived` })
      expect(
        await ui.find({ key: 'restore-44444444-4444-4444-8444-444444444444-20261001-101010-archived' }),
      ).toBeDefined()
      await ui.unmount()

      const narrow = await $.ui.mount({
        plugin: 'remote-control-cli-servers',
        surface,
        component: 'Pane',
        requestId: 'conductor-hosts',
        props: paneProps('Hosts', 44, 'dock'),
      })
      expect(await narrow.find({ key: `sm-${WAITING.id}` }), 'narrow layout').toBeDefined()
      await narrow.unmount()
    })

    test(`opens each dialog on the ${surface}`, async ($, on) => {
      const calls: Calls = []
      fakeHost(on, calls)
      await $.command.run(hostsText)
      const pane = await $.ui.mount({
        plugin: 'remote-control-cli-servers',
        surface,
        component: 'Pane',
        requestId: 'conductor-hosts',
        props: paneProps('Hosts', 100, 'dock'),
      })
      const dialog = () =>
        $.ui.mount({
          plugin: 'remote-control-cli-servers',
          surface,
          component: 'Pane',
          requestId: 'conductor-dialog',
          props: paneProps('Dialog', 90, 'inline'),
        })

      // Stop asks first, and stops once confirmed.
      await pane.press({ key: `sm-${RUNNING.id}` })
      await pane.press({ key: `mi-sm-${RUNNING.id}-stop` })
      let d = await dialog()
      expect(await d.find({ type: 'Text', text: /Claude ends/ }), 'check 1').toBeDefined()
      await d.press({ key: 'submit' })
      expect(calls).toContain(`POST /v1/accounts/Misc/sessions/${RUNNING.id}/stop`)
      await d.unmount()

      // The window of a session waiting for an answer.
      await pane.press({ key: `sm-${WAITING.id}` })
      await pane.press({ key: `mi-sm-${WAITING.id}-answer` })
      d = await dialog()
      if (surface === 'desktop') {
        // The desktop draws no Client region yet: the screen, with the key buttons and Type field.
        expect(await d.find({ type: 'Code' }), 'screen on the desktop').toBeDefined()
        await d.input({ key: 'type', text: 'y', kind: 'change' })
        await d.input({ key: 'type', text: 'y', kind: 'submit' })
        expect(calls.filter((c) => c === 'POST /v1/accounts/Misc/windows/@8/keys').length, 'a key, then Enter').toBe(2)
      } else {
        expect(await d.find({ key: 'term' }), 'typing region').toBeDefined()
        await d.post(
        {
          keys: [
            { seq: 1, key: { text: 'y' } },
            { seq: 2, key: { key: 'Down' } },
          ],
        },
        { in: 'term' },
      )
      await d.post(
        {
          keys: [
            { seq: 2, key: { key: 'Down' } },
            { seq: 3, key: { key: 'Enter' } },
          ],
        },
        { in: 'term' },
      )
        expect(calls.filter((c) => c === 'POST /v1/accounts/Misc/windows/@8/keys').length, 'each key sent once').toBe(2)
      }
      expect(await d.find({ key: 'key-Up' }), 'check 3').toBeDefined()
      await d.unmount()

      // Move plans, with a memory conflict to decide.
      await pane.press({ key: `sm-${STOPPED.id}` })
      await pane.press({ key: `mi-sm-${STOPPED.id}-move` })
      d = await dialog()
      expect(await d.find({ key: 'choice-notes.md' }), 'check 4').toBeDefined()
      expect(await d.find({ type: 'Text', text: /Files: 1 to copy/ }), 'check 5').toBeDefined()
      await d.unmount()

      // New session lists folders.
      await pane.press({ key: `am-${HOST_ID}/Misc` })
      await pane.press({ key: `mi-am-${HOST_ID}/Misc-newSession` })
      d = await dialog()
      expect(await d.find({ key: 'folder' }), 'check 6').toBeDefined()
      expect(await d.find({ key: 'trust' }), 'check 7').toBeDefined()
      await d.unmount()

      // Signing in a signed-out account opens its page and asks for the code.
      await pane.press({ key: `am-${HOST_ID}/Work` })
      await pane.press({ key: `mi-am-${HOST_ID}/Work-signIn` })
      d = await dialog()
      expect(calls).toContain('POST /v1/accounts/Work/login')
      expect(await d.find({ key: 'code' }), 'check 8').toBeDefined()
      await d.unmount()

      // Pairing reads the code as it's typed.
      await pane.press({ key: 'pm' })
      await pane.press({ key: 'mi-pm-pair' })
      d = await dialog()
      await d.input({ key: 'code', text: 'not a code', kind: 'change' })
      expect(await d.find({ type: 'Text', text: /isn't a pairing code/ }), 'check 9').toBeDefined()
      await d.unmount()

      // Host settings.
      await pane.press({ key: `hm-${HOST_ID}` })
      await pane.press({ key: `mi-hm-${HOST_ID}-settings` })
      d = await dialog()
      expect(await d.find({ key: 'suffix' }), 'check 10').toBeDefined()
      await d.unmount()
      await pane.unmount()
    })
  }
})

describe('Remote Control servers', () => {
  for (const surface of SURFACES) {
    test(`lists, stops and starts them on the ${surface}`, async ($, on) => {
      const calls: Calls = []
      fakeHost(on, calls)
      await $.command.run(hostsText)
      const pane = await $.ui.mount({
        plugin: 'remote-control-cli-servers',
        surface,
        component: 'Pane',
        requestId: 'conductor-hosts',
        props: paneProps('CLI Servers', 100, 'dock'),
      })
      const dialog = () =>
        $.ui.mount({
          plugin: 'remote-control-cli-servers',
          surface,
          component: 'Pane',
          requestId: 'conductor-dialog',
          props: paneProps('Dialog', 90, 'inline'),
        })
      expect(await pane.find({ type: 'Text', text: /proj \(orion\)/ }), 'the server row').toBeDefined()

      // Stop asks first.
      await pane.press({ key: 'rm-4121' })
      await pane.press({ key: 'mi-rm-4121-stop' })
      let d = await dialog()
      expect(await d.find({ type: 'Text', text: /stop answering/ })).toBeDefined()
      await d.press({ key: 'submit' })
      expect(calls).toContain('POST /v1/accounts/Misc/rc-servers/4121/stop')
      await d.unmount()

      // Start one from the account's menu, a worktree per session.
      await pane.press({ key: `am-${HOST_ID}/Misc` })
      await pane.press({ key: `mi-am-${HOST_ID}/Misc-server` })
      d = await dialog()
      expect(await d.find({ type: 'Text', text: /Remote Control server in Misc/ })).toBeDefined()
      await d.press({ key: 'spawn-worktree' })
      await d.press({ key: 'submit' })
      expect(calls).toContain('POST /v1/accounts/Misc/rc-servers')
      await d.unmount()
      await pane.unmount()
    })
  }
})

describe('the band above the prompt', () => {
  for (const surface of SURFACES) {
    test(`says what's waiting, and opens it, on the ${surface}`, async ($, on) => {
      const calls: Calls = []
      fakeHost(on, calls)
      await $.command.run(hostsText)
      const band = await $.ui.mount({
        plugin: 'remote-control-cli-servers',
        surface,
        component: 'AbovePrompt',
        props: bandProps(120),
      })
      expect(await band.find({ type: 'Text', text: '1 waiting' })).toBeDefined()
      expect(await band.find({ type: 'Text', text: 'ORION' })).toBeDefined()
      expect(await band.find({ key: 'another-band' }), "another plugin's band stays").toBeDefined()
      // One session waiting: the button answers it, opening its tmux window.
      await band.press({ key: 'rccs-band-answer' })
      expect(calls).toContain('GET /v1/accounts/Misc/windows/@8/screen')
      await band.unmount()

      // Narrow: only the totals.
      const narrow = await $.ui.mount({
        plugin: 'remote-control-cli-servers',
        surface,
        component: 'AbovePrompt',
        props: bandProps(30),
      })
      expect(await narrow.find({ type: 'Text', text: 'ORION' })).toBeUndefined()
      expect(await narrow.find({ type: 'Text', text: '1 waiting' })).toBeDefined()
      await narrow.unmount()
    })
  }

  for (const surface of SURFACES) {
    test(`turns off in Settings, and closes the open pane, on the ${surface}`, async ($, on) => {
      const calls: Calls = []
      fakeHost(on, calls)
      // The pane open: the band's button closes it.
      await $.command.run({ command: 'remote-control-cli-servers', args: '' } as never)
      const mountBand = () =>
        $.ui.mount({ plugin: 'remote-control-cli-servers', surface, component: 'AbovePrompt', props: bandProps(120) })
      let band = await mountBand()
      expect(await band.find({ key: 'rccs-band-close' }), 'Close while the pane is open').toBeDefined()
      await band.press({ key: 'rccs-band-close' })
      await band.unmount()
      band = await mountBand()
      expect(await band.find({ key: 'rccs-band-answer' }), 'Answer once it closed').toBeDefined()
      await band.unmount()

      // Settings, from the pane's header: the band off.
      await $.command.run({ command: 'remote-control-cli-servers', args: '' } as never)
      const pane = await $.ui.mount({
        plugin: 'remote-control-cli-servers',
        surface,
        component: 'Pane',
        requestId: 'conductor-hosts',
        props: paneProps('CLI Servers', 100, 'dock'),
      })
      await pane.press({ key: 'pm' })
      await pane.press({ key: 'mi-pm-settings' })
      const settings = await $.ui.mount({
        plugin: 'remote-control-cli-servers',
        surface,
        component: 'Pane',
        requestId: 'conductor-dialog',
        props: paneProps('Settings', 90, 'inline'),
      })
      expect(await settings.find({ type: 'Text', text: /hosts are read every 30 seconds/ })).toBeDefined()
      await settings.press({ key: 'band' })
      band = await mountBand()
      expect(await band.find({ key: 'rccs-band-close' }), 'no band once it is off').toBeUndefined()
      expect(await band.find({ key: 'another-band' }), "another plugin's band stays").toBeDefined()
      await band.unmount()
      await settings.unmount()
      await pane.unmount()
    })
  }
})

describe('demo mode', () => {
  test('shows made-up hosts, and never runs a request', async ($, on) => {
    const calls: Calls = []
    fakeHost(on, calls)
    await $.command.run({ command: 'remote-control-cli-servers', args: 'demo' } as never)
    const { text } = await $.command.run(hostsText)
    expect(text).toContain('atlas (server 0.6.3)')
    expect(text).toContain('nebula')
    expect(text).toContain('◐ Search tuning (ATL)')
    expect(text).not.toContain('orion')
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({
        plugin: 'remote-control-cli-servers',
        surface,
        component: 'Pane',
        requestId: 'conductor-hosts',
        props: paneProps('CLI Servers', 100, 'dock'),
      })
      expect(await ui.find({ type: 'Text', text: /DEMO/ })).toBeDefined()
      await ui.unmount()
    }
    expect(calls, 'no request reached a host').toEqual([])
  })
})
