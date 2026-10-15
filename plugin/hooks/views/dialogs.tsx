// The dialog pane: one dialog at a time, drawn from `ConductorDialog` with the
// parts in kit.tsx, so every dialog reads like the main pane: an icon head
// naming what it acts on, titled sections in rounded frames, then the foot.

import type { RenderElement } from 'claude-code'
import type { ConductorDialog, ConductorHost, ConductorView } from '../../types'
import type { DialogAct, Ui } from './act'

import { folderName, formatBytes, shortenHome } from '../lib/format'
import { trimScreen, WINDOW_KEYS } from '../lib/keys'
import { automaticMemory, conflicts, isRunning, planSummary } from '../lib/move'
import { accountNameHint, isValidAccountName, isValidSessionName, suffixProblem } from '../lib/names'
import { decodePairingCode, formatFingerprint } from '../lib/pairing'
import { launchNote, launchTitle } from '../lib/texts'
import { Icon } from './icons'
import { Check, ErrorBox, Fact, Foot, Head, Hint, Section } from './kit'

/** What the pane's tab says for each dialog. */
export function dialogTitle(dialog: ConductorDialog, view: ConductorView): string {
  const host = (id: string) => view.hosts.find((known) => known.id === id)?.label ?? 'host'
  switch (dialog.kind) {
    case 'pair':
      return 'Pair a host'
    case 'settings':
      return 'Settings'
    case 'host':
      return `${host(dialog.hostId)} settings`
    case 'newAccount':
      return `New profile on ${host(dialog.hostId)}`
    case 'renameAccount':
      return `Rename ${dialog.account}`
    case 'signIn':
      return dialog.isSwitch ? `Switch ${dialog.account}` : `Sign in ${dialog.account}`
    case 'newSession':
      return dialog.isServer ? `Remote Control server in ${dialog.account}` : `New session in ${dialog.account}`
    case 'renameSession':
      return 'Rename session'
    case 'move':
      return 'Move session'
    case 'window':
      return dialog.target.title
    case 'confirm':
      return dialog.title
  }
}

/** The rows a dialog wants when it opens inline. */
export function dialogRows(dialog: ConductorDialog): number {
  switch (dialog.kind) {
    case 'window':
      return 42
    case 'move':
    case 'newSession':
      return 34
    default:
      return 22
  }
}

const where = (host: ConductorHost | undefined) => [host?.hostname, host?.address].filter(Boolean).join(' · ')

function SettingsDialog(ui: Ui, d: Extract<ConductorDialog, { kind: 'settings' }>, act: DialogAct) {
  return [
    Head(ui, 'host', 'permission', 'Settings', 'Remote Control CLI Servers, on this Mac'),
    Section(ui, 'Band above the prompt', [
      Check(ui, 'band', 'Show the hosts above the prompt', d.isBandOn, () => act.setBand(!d.isBandOn)),
      Hint(
        ui,
        d.isBandOn
          ? 'One line under the conversation: sessions waiting for you, and how each host is doing. The hosts are read every 30 seconds.'
          : 'Off: nothing is read in the background, and the status line says when a session is waiting while the pane is open.',
      ),
    ]),
    Section(ui, 'Demo mode', [
      Check(ui, 'demo', 'Show made-up hosts, for screenshots', d.isDemo, () => act.setDemo(!d.isDemo)),
      Hint(ui, "While it's on, nothing reaches a real host."),
    ]),
    Foot(ui, null, { label: 'Done', onPress: act.close }),
  ]
}

function PairDialog(ui: Ui, d: Extract<ConductorDialog, { kind: 'pair' }>, act: DialogAct) {
  const { Input, Text } = ui
  const decoded = decodePairingCode(d.code)
  const isCode = !('error' in decoded)
  return [
    Head(ui, 'host', 'permission', 'Pair a host', 'A Linux machine running remote-control-conductor-server'),
    Section(
      ui,
      'Pairing code',
      [
        <Input
          key="code"
          placeholder="aip1.…"
          value={d.code}
          autoFocus
          onInput={(value) => act.patch({ code: value, error: null })}
          onSubmit={() => act.submit()}
        />,
        'error' in decoded && decoded.error
          ? Hint(ui, decoded.error, true)
          : Hint(ui, 'On the host, run remote-control-conductor-server pair and paste the code it prints.'),
      ],
      isCode ? 'success' : 'promptBorder',
    ),
    isCode &&
      Section(ui, 'Check the certificate', [
        Fact(ui, 'Reaches it at', decoded.hosts.join(', ')),
        Fact(ui, 'Fingerprint', formatFingerprint(decoded.fingerprint).slice(0, 47), 'claude'),
        <Text key="fp-rest" color="claude">
          {' '.repeat(15)}
          {formatFingerprint(decoded.fingerprint).slice(48)}
        </Text>,
        Hint(ui, 'It should match the one the server printed. Only this certificate will be trusted for this host.'),
      ]),
    Section(ui, 'Name', [
      <Input
        key="label"
        placeholder="Its host name"
        value={d.label}
        onInput={(value) => act.patch({ label: value })}
        onSubmit={() => act.submit()}
      />,
      Hint(ui, 'Optional. What this list calls it.'),
    ]),
    ErrorBox(ui, d.error),
    Foot(
      ui,
      { label: 'Pair', isEnabled: isCode, isBusy: d.isBusy, onPress: act.submit },
      { label: 'Cancel', onPress: act.close },
    ),
  ]
}

function HostDialog(
  ui: Ui,
  d: Extract<ConductorDialog, { kind: 'host' }>,
  host: ConductorHost | undefined,
  act: DialogAct,
) {
  const { Button, Input } = ui
  const problem = suffixProblem(d.suffix)
  const hasSettings = host?.info?.settings !== null && host?.info?.settings !== undefined
  const example = `Deploy (${d.suffix.trim() || d.label})`
  return [
    Head(ui, host?.error ? 'offline' : 'host', host?.error ? 'error' : 'success', d.label || 'Host', where(host)),
    Section(ui, 'Name', [
      <Input
        key="label"
        value={d.label}
        autoFocus
        onInput={(value) => act.patch({ label: value, error: null })}
        onSubmit={() => act.submit()}
      />,
      Hint(ui, "What this list calls it. The server isn't changed."),
    ]),
    Section(
      ui,
      'Remote Control names',
      hasSettings
        ? [
            Check(ui, 'suffix-on', 'Add the host to session names', d.isSuffixOn, () =>
              act.patch({ isSuffixOn: !d.isSuffixOn }),
            ),
            d.isSuffixOn && (
              <Input
                key="suffix"
                label="Suffix "
                value={d.suffix}
                onInput={(value) => act.patch({ suffix: value, error: null })}
                onSubmit={() => act.submit()}
              />
            ),
            d.isSuffixOn && problem
              ? Hint(ui, problem, true)
              : Hint(ui, `Sessions started or restarted from now on, e.g. "${example}".`),
          ]
        : [Hint(ui, `Update the server on ${d.label} to add its name to Remote Control sessions.`)],
    ),
    ErrorBox(ui, d.error),
    Foot(
      ui,
      {
        label: 'Save',
        isEnabled: d.label.trim().length > 0 && !(d.isSuffixOn && problem),
        isBusy: d.isBusy,
        onPress: act.submit,
      },
      { label: 'Cancel', onPress: act.close },
      <Button key="remove" dimColor label="Remove host…" onPress={() => act.removeHost(d.hostId)} />,
    ),
  ]
}

function NewAccountDialog(
  ui: Ui,
  d: Extract<ConductorDialog, { kind: 'newAccount' }>,
  host: ConductorHost | undefined,
  act: DialogAct,
) {
  const { Input } = ui
  const taken = host?.accounts.map((a) => a.account.name) ?? []
  const hint = accountNameHint(d.name, host?.label ?? 'The host', taken)
  return [
    Head(
      ui,
      'claude',
      'claude',
      'New profile',
      `On ${host?.label ?? 'the host'}: Claude runs there in tmux, signed in as its own account`,
    ),
    Section(
      ui,
      'Name',
      [
        <Input
          key="name"
          placeholder="work"
          value={d.name}
          autoFocus
          onInput={(value) => act.patch({ name: value, error: null })}
          onSubmit={() => act.submit()}
        />,
        hint.text.trim()
          ? Hint(ui, hint.text, hint.problem)
          : Hint(ui, 'Letters, digits, - and _. It names its folder on the host.'),
      ],
      hint.problem ? 'error' : 'promptBorder',
    ),
    Section(ui, 'Then', [
      Hint(ui, "It's signed in next: its sign-in page opens in your browser, and you paste the code back here."),
    ]),
    ErrorBox(ui, d.error),
    Foot(
      ui,
      {
        label: 'Create profile',
        isEnabled: isValidAccountName(d.name.trim()) && !hint.problem,
        isBusy: d.isBusy,
        onPress: act.submit,
      },
      { label: 'Cancel', onPress: act.close },
    ),
  ]
}

function RenameAccountDialog(
  ui: Ui,
  d: Extract<ConductorDialog, { kind: 'renameAccount' }>,
  host: ConductorHost | undefined,
  act: DialogAct,
) {
  const { Input } = ui
  const others = host?.accounts.map((a) => a.account.name).filter((n) => n !== d.account) ?? []
  const hint = accountNameHint(d.name, host?.label ?? 'The host', others)
  const running =
    host?.accounts.find((a) => a.account.name === d.account)?.sessions.filter((s) => s.running).length ?? 0
  const isRenaming = d.name.trim() !== d.account
  return [
    Head(ui, 'claude', 'claude', `Rename ${d.account}`, `On ${host?.label ?? 'the host'}`),
    Section(
      ui,
      'New name',
      [
        <Input
          key="name"
          value={d.name}
          autoFocus
          onInput={(value) => act.patch({ name: value, error: null })}
          onSubmit={() => act.submit()}
        />,
        Hint(ui, hint.text, hint.problem),
      ],
      hint.problem ? 'error' : 'promptBorder',
    ),
    isRenaming &&
      running > 0 &&
      Section(
        ui,
        'Running sessions',
        [
          Hint(
            ui,
            `${running === 1 ? '1 session has' : `${running} sessions have`} its folder open, and ${running === 1 ? 'stops' : 'stop'} first. Resume ${running === 1 ? 'it' : 'them'} afterwards.`,
          ),
        ],
        'warning',
      ),
    ErrorBox(ui, d.error),
    Foot(
      ui,
      {
        label: isRenaming && running > 0 ? 'Stop sessions and save' : 'Save',
        isEnabled: isRenaming && !hint.problem,
        isBusy: d.isBusy,
        onPress: act.submit,
      },
      { label: 'Cancel', onPress: act.close },
    ),
  ]
}

function SignInDialog(
  ui: Ui,
  d: Extract<ConductorDialog, { kind: 'signIn' }>,
  host: ConductorHost | undefined,
  act: DialogAct,
) {
  const { Box, Button, Input, Link, Text } = ui
  const label = host?.label ?? 'the host'
  const head = Head(
    ui,
    'claude',
    'claude',
    d.isSwitch ? `Switch ${d.account} to another account` : `Sign in ${d.account}`,
    d.previousEmail ? `On ${label} · now ${d.previousEmail}` : `On ${label}`,
  )
  const cancel = { label: 'Cancel', onPress: act.close }
  if (d.phase === 'confirmSwitch') {
    const a = host?.accounts.find((x) => x.account.name === d.account)
    const running = a?.sessions.filter((s) => s.running).length ?? 0
    return [
      head,
      Section(ui, 'What happens', [
        Hint(
          ui,
          running > 0
            ? `Its ${running === 1 ? 'session stops' : `${running} sessions stop`}, and ${running === 1 ? 'resumes' : 'resume'} under the new account as soon as it's signed in: the same conversations, with Remote Control on.`
            : 'It signs out, then in as the other account.',
        ),
        Hint(ui, 'Nothing moves, and no other profile is touched.'),
      ]),
      Section(ui, 'In the browser', [
        Hint(
          ui,
          `A sign-in page opens. Sign in there as the other account${d.previousEmail ? `: if claude.ai shows ${d.previousEmail}, switch account on claude.ai first` : ''}.`,
        ),
      ]),
      ErrorBox(ui, d.error),
      Foot(
        ui,
        { label: 'Switch account', isEnabled: true, isBusy: false, onPress: act.submit },
        cancel,
        <Button key="sign-out" dimColor label="Sign out only…" onPress={act.signOut} />,
      ),
    ]
  }
  if (d.phase === 'starting') {
    return [
      head,
      <Box key="starting" gap={1} borderStyle="round" borderColor="suggestion" paddingX={1}>
        <Text color="suggestion">◐</Text>
        <Text>Asking {label} for a sign-in page…</Text>
      </Box>,
      Foot(ui, null, cancel),
    ]
  }
  const isEnded = d.phase === 'ended'
  return [
    head,
    Section(ui, '1  Sign in in the browser', [
      Hint(
        ui,
        `The sign-in page is open. Sign in with the account ${d.account} should use, then copy the code it shows.`,
      ),
      d.url && <Link key="again-link" href={d.url} label="Open the page again" />,
    ]),
    !isEnded &&
      Section(
        ui,
        '2  Paste the code',
        [
          <Input
            key="code"
            placeholder="Paste the code here"
            value={d.code}
            autoFocus
            submitLabel="sign in"
            onInput={(value) => act.patch({ code: value, error: null })}
            onSubmit={() => act.submit()}
          />,
        ],
        d.code.trim() ? 'success' : 'promptBorder',
      ),
    ErrorBox(ui, d.error),
    isEnded
      ? Foot(
          ui,
          { label: 'Sign in again', isEnabled: true, isBusy: false, onPress: act.startSignIn },
          { label: 'Close', onPress: act.close },
        )
      : Foot(
          ui,
          {
            label: 'Sign in',
            isEnabled: d.code.trim().length > 0,
            isBusy: d.phase === 'submitting',
            onPress: act.submit,
          },
          cancel,
        ),
  ]
}

function NewSessionDialog(
  ui: Ui,
  d: Extract<ConductorDialog, { kind: 'newSession' }>,
  host: ConductorHost | undefined,
  act: DialogAct,
) {
  const { Box, Button, Input, Select, Text } = ui
  const listing = d.listing
  const home = listing?.home ?? host?.info?.home ?? null
  const recent = [
    ...new Set(
      (host?.accounts.find((a) => a.account.name === d.account)?.sessions ?? [])
        .map((s) => s.cwd)
        .filter((c): c is string => Boolean(c)),
    ),
  ].slice(0, 5)
  const options = [
    { value: '.', label: listing ? `${shortenHome(listing.path, home)}  (start here)` : '…' },
    ...(listing?.parent ? [{ value: listing.parent, label: '..  up one folder' }] : []),
    ...(listing?.entries ?? []).map((e) => ({ value: e.path, label: `${e.name}/` })),
  ]
  const running = listing
    ? host?.accounts.find((a) => a.account.name === d.account)?.servers?.find((server) => server.folder === listing.path)
    : undefined
  return [
    d.isServer
      ? Head(
          ui,
          'remote',
          'permission',
          `Remote Control server in ${d.account}`,
          `On ${host?.label ?? 'the host'} · lets the Claude apps start sessions in a folder`,
        )
      : Head(
          ui,
          'claude',
          'claude',
          `New session in ${d.account}`,
          `On ${host?.label ?? 'the host'} · in tmux, with Remote Control on`,
        ),
    Section(ui, 'Folder', [
      <Box key="path" gap={1} alignItems="center">
        {Icon(ui, 'folder', 'claude')}
        <Text bold color="claude">
          {listing ? shortenHome(listing.path, home) : '…'}
        </Text>
      </Box>,
      <Select
        key="folder"
        label="Go to "
        options={options}
        value="."
        autoFocus
        onSelect={(value) => value !== '.' && act.browse(value)}
      />,
      listing && listing.entries.length === 0 && Hint(ui, 'No folders inside. Start here, or go up.'),
      listing?.truncated && Hint(ui, 'Only the first 500 are listed.'),
      recent.length > 0 && (
        <Box key="recent" columnGap={2} flexWrap="wrap">
          <Text dimColor>Recent</Text>
          {recent.map((path, i) => (
            <Button
              key={`recent-${i}`}
              plain
              dimColor
              label={shortenHome(path, home)}
              onPress={() => act.browse(path)}
            />
          ))}
        </Box>
      ),
    ]),
    d.isServer &&
      running &&
      Section(
        ui,
        'Already running',
        [
          Hint(
            ui,
            `${running.name ?? folderName(running.folder)} serves this folder (${running.spawn === 'worktree' ? 'a worktree per session' : 'sessions in this folder'}, ${running.sessions} now). Start sessions here from claude.ai or the Claude app.`,
          ),
        ],
        'permission',
      ),
    d.isServer &&
      Section(ui, 'Sessions', [
        Check(ui, 'spawn-same', 'In this folder', d.spawn === 'same-dir', () => act.patch({ spawn: 'same-dir' })),
        Check(ui, 'spawn-worktree', 'Each in a git worktree of its own', d.spawn === 'worktree', () =>
          act.patch({ spawn: 'worktree' }),
        ),
        Hint(
          ui,
          d.spawn === 'worktree'
            ? 'Sessions don’t step on each other’s files. The folder must be a git repository.'
            : 'Every session the apps start works in this folder, so two can edit the same files.',
        ),
      ]),
    Section(ui, 'Name', [
      <Input
        key="name"
        placeholder={listing ? folderName(listing.path) : 'Named by Remote Control'}
        value={d.name}
        onInput={(value) => act.patch({ name: value, isNameTouched: true })}
        onSubmit={() => act.submit()}
      />,
      Hint(
        ui,
        d.isServer
          ? 'What the Claude apps call this server. The folder’s name unless you change it.'
          : 'What Remote Control, tmux and this list call it. The folder’s name unless you change it.',
      ),
    ]),
    Section(ui, 'Trust', [
      Check(ui, 'trust', 'Trust this folder', d.trustFolder, () => act.patch({ trustFolder: !d.trustFolder })),
      Hint(
        ui,
        "Answers Claude's \"do you trust this folder?\" for you. Remote Control can't connect until it's answered.",
      ),
    ]),
    ErrorBox(ui, d.error),
    Foot(
      ui,
      {
        label: d.isServer ? 'Start server' : 'Start',
        isEnabled: listing !== null && !(d.isServer && running),
        isBusy: d.isBusy,
        onPress: act.submit,
      },
      { label: 'Cancel', onPress: act.close },
    ),
  ]
}

function RenameSessionDialog(ui: Ui, d: Extract<ConductorDialog, { kind: 'renameSession' }>, act: DialogAct) {
  const { Input } = ui
  return [
    Head(
      ui,
      d.running ? 'running' : 'stopped',
      d.running ? 'success' : 'inactive',
      d.target.title,
      `In ${d.target.account}`,
    ),
    Section(ui, 'New name', [
      <Input
        key="name"
        placeholder={d.target.title}
        value={d.name}
        autoFocus
        onInput={(value) => act.patch({ name: value, error: null })}
        onSubmit={() => act.submit()}
      />,
      Hint(
        ui,
        d.running
          ? 'Claude takes it now, and so does the Claude app. It has to be idle, at an empty prompt.'
          : 'Written to the session now. The Claude app shows it once the session is resumed.',
      ),
    ]),
    ErrorBox(ui, d.error),
    Foot(
      ui,
      { label: 'Rename', isEnabled: isValidSessionName(d.name), isBusy: d.isBusy, onPress: act.submit },
      { label: 'Cancel', onPress: act.close },
    ),
  ]
}

function MoveDialog(
  ui: Ui,
  d: Extract<ConductorDialog, { kind: 'move' }>,
  host: ConductorHost | undefined,
  act: DialogAct,
) {
  const { Box, Select, Text } = ui
  const destinations = (host?.accounts ?? []).map((a) => a.account.name).filter((n) => n !== d.target.account)
  const head = Head(
    ui,
    'claude',
    'claude',
    d.target.title,
    `${d.target.account} → ${d.to || '…'} · on ${host?.label ?? 'the host'}`,
  )
  if (d.phase === 'moving') {
    const steps = d.progress?.steps ?? []
    const current = d.progress?.current ?? 0
    return [
      head,
      Section(
        ui,
        'Moving',
        [
          steps.length === 0 && (
            <Text key="starting" color="suggestion">
              ◐ Starting the move…
            </Text>
          ),
          ...steps.map((step, i) => (
            <Text key={`step-${i}`} color={i < current ? 'success' : i === current ? 'suggestion' : 'inactive'}>
              {i < current ? '✓' : i === current ? '◐' : '·'} {step}
            </Text>
          )),
          Hint(ui, 'A long conversation takes a while to copy.'),
        ],
        'suggestion',
      ),
    ]
  }
  if (destinations.length === 0) {
    return [
      head,
      Hint(ui, `${host?.label ?? 'The host'} has no other profile to move it to.`),
      Foot(ui, null, { label: 'Close', onPress: act.close }),
    ]
  }
  const plan = d.plan
  const running = plan ? isRunning(plan) : false
  const conflictFiles = plan ? conflicts(plan) : []
  const auto = plan ? automaticMemory(plan) : []
  const choiceOptions = (newer: string) => [
    { value: 'newer', label: `Keep newer (${newer === 'source' ? d.target.account : d.to}'s)` },
    { value: 'source', label: `${d.target.account}'s` },
    { value: 'destination', label: `${d.to}'s` },
    { value: 'merged', label: 'Merge with Claude' },
  ]
  return [
    head,
    Section(ui, 'To', [
      <Select
        key="to"
        options={destinations.map((n) => ({ value: n, label: n }))}
        value={d.to}
        autoFocus
        onSelect={(value) => act.moveTo(value)}
      />,
    ]),
    Section(
      ui,
      'What it does',
      plan
        ? [
            Hint(ui, planSummary(plan)),
            running &&
              Hint(
                ui,
                `It's running under ${d.target.account}. Moving exits it first, so the whole conversation goes and nothing writes to it meanwhile.`,
              ),
            plan.destinationNewer &&
              Check(
                ui,
                'replace-newer',
                `${d.to} has a newer copy. Replace it anyway? It's backed up first.`,
                d.replaceNewer,
                () => act.patch({ replaceNewer: !d.replaceNewer }),
              ),
          ]
        : [
            d.error ? null : (
              <Text key="checking" color="suggestion">
                ◐ Checking…
              </Text>
            ),
          ],
      running || plan?.destinationNewer ? 'warning' : 'promptBorder',
    ),
    (conflictFiles.length > 0 || auto.length > 0) &&
      Section(
        ui,
        'Project memory',
        [
          ...conflictFiles.map((file) => (
            <Box key={`mem-${file.path}`} flexDirection="column" marginBottom={1}>
              <Text>
                <Text color="warning">memory/{file.path}</Text>
                <Text dimColor> · both profiles changed it</Text>
              </Text>
              <Select
                key={`choice-${file.path}`}
                label="Keep "
                options={choiceOptions(file.newer)}
                value={d.choices[file.path] ?? 'newer'}
                onSelect={(value) =>
                  value === 'merged'
                    ? act.merge(file.path)
                    : act.patch({ choices: { ...d.choices, [file.path]: value } })
                }
              />
              {d.merging === file.path && <Text color="suggestion">◐ Claude is merging…</Text>}
              {d.merged[file.path] !== undefined && d.choices[file.path] === 'merged' && (
                <Box flexDirection="column" borderStyle="round" borderColor="permission" paddingX={1}>
                  <Text color="permission">Claude's merge</Text>
                  <Text>{d.merged[file.path]}</Text>
                </Box>
              )}
            </Box>
          )),
          ...auto.map((line) => (
            <Text key={`auto-${line}`} dimColor>
              {line}
            </Text>
          )),
        ],
        conflictFiles.length ? 'warning' : 'promptBorder',
      ),
    Section(ui, `Afterwards, in ${d.target.account}`, [
      <Select
        key="afterwards"
        options={[
          {
            value: 'archive',
            label: plan?.archiveBytes ? `Archive it (up to ${formatBytes(plan.archiveBytes)})` : 'Archive it',
          },
          { value: 'delete', label: 'Delete it' },
          { value: 'keep', label: 'Keep it' },
        ]}
        value={d.afterwards}
        onSelect={(value) => act.patch({ afterwards: value })}
      />,
      Hint(
        ui,
        d.afterwards === 'archive'
          ? 'Only one profile lists it. Its transcript is kept, compressed, and can be restored.'
          : d.afterwards === 'delete'
            ? "Only after the moved copy is checked to be identical. It can't be undone."
            : 'This forks the session: two copies that go their own ways from here.',
      ),
      Check(ui, 'resume', `Resume it under ${d.to} afterwards`, d.resume, () => act.patch({ resume: !d.resume })),
    ]),
    ErrorBox(ui, d.error),
    Foot(
      ui,
      {
        label: running ? 'Exit and move' : 'Move',
        isEnabled: plan !== null && (!plan.destinationNewer || d.replaceNewer) && d.merging === null,
        isBusy: false,
        onPress: act.submit,
      },
      { label: 'Cancel', onPress: act.close },
    ),
  ]
}

/** The window's screen as shown: trimmed, without control characters. */
const shownScreen = (d: Extract<ConductorDialog, { kind: 'window' }>) =>
  d.screen ? trimScreen(d.screen.text).replace(/[^\P{Cc}\n\t]/gu, '') : ''

/**
 * What the terminal's live region (../terminal.tsx) is drawn with, or null where there's none.
 * register.tsx draws the region itself, so the directory reads its module off the hooks module.
 */
export function windowRegionProps(d: ConductorDialog, surface: Ui['surface']) {
  if (d.kind !== 'window' || surface !== 'terminal' || d.isGone) return null
  const screen = shownScreen(d)
  return screen ? { text: screen.slice(-9000), ack: d.ack, isGone: d.isGone } : null
}

function WindowDialog(
  ui: Ui,
  d: Extract<ConductorDialog, { kind: 'window' }>,
  host: ConductorHost | undefined,
  act: DialogAct,
  region: RenderElement | null,
) {
  const { Box, Button, Code, Input, Text } = ui
  // The desktop doesn't draw a live region yet: there the screen is shown, and the keys and the
  // Type field below send input. The terminal's region (`region`) takes keys typed straight into it.
  const isDesktop = ui.surface === 'desktop'
  const screen = shownScreen(d)
  const isUp = Boolean(d.screen?.sessionId)
  return [
    Head(
      ui,
      d.isGone ? 'stopped' : d.launch?.attention && !isUp ? 'waiting' : 'running',
      d.isGone ? 'inactive' : d.launch?.attention && !isUp ? 'warning' : 'success',
      d.target.title,
      `tmux window ${d.windowId} · ${d.target.account} on ${host?.label ?? 'the host'}`,
    ),
    d.launch &&
      Section(
        ui,
        launchTitle(d.launch),
        [
          Hint(ui, launchNote(d.launch, d.screen)),
          d.launch.attention?.kind === 'trustPermissions' && (
            <Text key="perm" color="warning">
              {d.launch.attention.text}
            </Text>
          ),
        ],
        isUp ? 'success' : d.launch.attention ? 'warning' : 'promptBorder',
      ),
    <Box
      key="screen"
      flexDirection="column"
      borderStyle="round"
      borderColor={d.isGone ? 'inactive' : 'permission'}
      paddingX={1}
    >
      <Text color={d.isGone ? 'inactive' : 'permission'} bold>
        {d.isGone ? 'The tmux window has closed' : 'Live tmux window'}
      </Text>
      {d.isGone ? null : screen && isDesktop ? (
        <Code source={screen.slice(-9000)} language="text" />
      ) : screen && region ? (
        region
      ) : (
        <Text dimColor>…</Text>
      )}
    </Box>,
    !d.isGone && (
      <Box key="keys" flexDirection="column" marginTop={1} rowGap={1}>
        <Input
          key="type"
          placeholder="Type here: each key goes straight to the window"
          value={d.text}
          submitLabel="⏎"
          onInput={(value) => act.typeLive(value)}
          onSubmit={() => act.submitLive()}
        />
        <Box justifyContent="space-between" alignItems="center" flexWrap="wrap" rowGap={1}>
          <Box columnGap={1} alignItems="center">
            {WINDOW_KEYS.map((k) => (
              <Button key={`key-${k.key}`} plain dimColor label={k.label} onPress={() => act.sendKeys([{ key: k.key }])} />
            ))}
          </Box>
          <Box columnGap={2} alignItems="center">
            <Button key="copy" plain dimColor label="Copy attach command" onPress={act.copyAttach} />
            <Button key="terminal" plain dimColor label="Open in Terminal" onPress={act.openTerminal} />
          </Box>
        </Box>
      </Box>
    ),
    ErrorBox(ui, d.error),
    Foot(ui, null, { label: d.launch?.attention && !isUp ? 'Leave it waiting' : 'Done', onPress: act.close }),
  ]
}

function ConfirmDialog(ui: Ui, d: Extract<ConductorDialog, { kind: 'confirm' }>, act: DialogAct) {
  const [subject, ...rest] = d.body.split('\n\n')
  const hasSubject = rest.length > 0
  const icon =
    d.action.kind === 'removeHost'
      ? 'host'
      : d.action.kind === 'signOut' || d.action.kind === 'deleteAccount'
        ? 'claude'
        : 'stopped'
  return [
    Head(ui, icon, d.isDanger ? 'error' : 'claude', d.title, hasSubject ? subject : undefined),
    Section(
      ui,
      d.isDanger ? 'This stops or removes something' : 'What happens',
      [Hint(ui, hasSubject ? rest.join('\n\n') : d.body)],
      d.isDanger ? 'error' : 'promptBorder',
    ),
    ErrorBox(ui, d.error),
    Foot(
      ui,
      { label: d.confirmLabel, isEnabled: true, isBusy: d.isBusy, onPress: act.submit },
      { label: 'Cancel', onPress: act.close },
    ),
  ]
}

/** The dialog pane's content. */
export function Dialog(
  ui: Ui,
  dialog: ConductorDialog,
  view: ConductorView,
  act: DialogAct,
  region: RenderElement | null,
) {
  const { Box } = ui
  const hostId = 'hostId' in dialog ? dialog.hostId : 'target' in dialog ? dialog.target.hostId : null
  const host = hostId ? view.hosts.find((known) => known.id === hostId) : undefined
  const body = (() => {
    switch (dialog.kind) {
      case 'pair':
        return PairDialog(ui, dialog, act)
      case 'settings':
        return SettingsDialog(ui, dialog, act)
      case 'host':
        return HostDialog(ui, dialog, host, act)
      case 'newAccount':
        return NewAccountDialog(ui, dialog, host, act)
      case 'renameAccount':
        return RenameAccountDialog(ui, dialog, host, act)
      case 'signIn':
        return SignInDialog(ui, dialog, host, act)
      case 'newSession':
        return NewSessionDialog(ui, dialog, host, act)
      case 'renameSession':
        return RenameSessionDialog(ui, dialog, act)
      case 'move':
        return MoveDialog(ui, dialog, host, act)
      case 'window':
        return WindowDialog(ui, dialog, host, act, region)
      case 'confirm':
        return ConfirmDialog(ui, dialog, act)
    }
  })()
  return <Box flexDirection="column">{body.filter(Boolean) as never}</Box>
}
