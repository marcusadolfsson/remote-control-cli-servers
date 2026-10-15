// The plugin's type contract: the server's wire types (core/src/api.rs, JSON
// camelCase) and what the plugin keeps in $.state.

export type HostSettings = { remoteControlSuffix?: string | null }

export type HostInfo = {
  hostname: string
  home: string
  serverVersion: string
  apiVersion: number
  tmux: { version: string; session: string } | null
  claude: { path: string; version: string | null } | null
  accountsBase: string
  includesDefault: boolean
  settings?: HostSettings | null
}

export type ProfileAccount = {
  email: string | null
  name: string | null
  organization: string | null
  plan: string | null
}

export type RemoteAccount = {
  name: string
  isDefault: boolean
  configDir: string
  account: ProfileAccount | null
  signedIn: boolean
  signedInUntil?: string | null
  sessions: number
  runningSessions: number
  pendingResume?: number
  /** A link to a profile the Mac app owns: rename and delete it there. */
  linked?: boolean
}

export type TmuxWindow = { session: string; windowId: string; paneId: string }

export type RemoteSession = {
  id: string
  cwd: string | null
  title: string | null
  named: boolean
  lastPrompt: string | null
  updatedAt: string
  sizeBytes: number
  running: boolean
  window: TmuxWindow | null
  remoteControl: boolean
  bridgeSessionId?: string | null
  waiting?: boolean
  remoteControlConnecting?: boolean
  empty?: boolean
  claudeVersion?: string | null
  updatePending?: boolean
  installedVersion?: string | null
  /** Started and served by a Remote Control server (`claude remote-control`). */
  served?: boolean
}

export type AttentionKind = 'trustPrompt' | 'trustPermissions' | 'waiting' | 'enableRemoteControl'

/** A Remote Control server: `claude remote-control` in a folder, so the Claude apps can start sessions there. */
export type RcServer = {
  pid: number
  folder: string
  name: string | null
  spawn: string
  sessions: number
  /** Its window, when the host's server started it: then it can be shown and stopped. */
  window: TmuxWindow | null
  environmentUrl: string | null
  attention: { kind: AttentionKind; text: string } | null
  /** The Claude Code it runs, when the server can tell (0.11+). */
  claudeVersion?: string | null
  /** A newer Claude Code is installed: restarting the server runs it. */
  updatePending?: boolean
  installedVersion?: string | null
}

export type StartRcServerResult = { server: RcServer; alreadyRunning: boolean; attachCommand: string | null }

export type LaunchResult = {
  window: TmuxWindow
  alreadyRunning: boolean
  sessionId: string | null
  remoteControlName: string | null
  attention: { kind: AttentionKind; text: string } | null
  attachCommand: string
}

export type LogoutResult = { stopped: number; stoppedIds?: Array<string> }
export type LoginStart = { loginId: string; url: string; expiresAt: string }
export type RenameSessionResult = { name: string; live: boolean }

export type WindowScreen = {
  text: string
  width: number
  height: number
  sessionId?: string | null
  remoteControl?: boolean
}

export type WindowKey = { key: string } | { text: string }

export type DirListing = {
  path: string
  parent: string | null
  home: string
  entries: Array<{ name: string; path: string }>
  truncated: boolean
}

export type Side = 'source' | 'destination'
export type MemoryAction = 'add' | 'same' | 'index' | 'merge' | 'conflict'
export type Decision = { take: 'source' } | { take: 'destination' } | { take: 'merged'; text: string }

export type TransferPlan = {
  sessionId: string
  source: string
  destination: string
  title: string | null
  cwd: string | null
  items: Array<{ path: string; action: 'copy' | 'same' | 'replace' | 'remove' }>
  destinationNewer: boolean
  memory: Array<{
    path: string
    action: MemoryAction
    newer: Side
    sourceText: string | null
    destinationText: string | null
  }>
  running: Array<{ account: string; pid: number; sessionId: string | null; exact: boolean }>
  sourceBytes?: number
  archiveBytes?: number
}

export type MoveProgress = { steps: Array<string>; current: number }

export type TransferReport = {
  changed: boolean
  backupDir: string | null
  memory: Array<string>
  archivedTo: string | null
  freedBytes?: number | null
  deleteError?: string | null
  launch: LaunchResult | null
  resumeError: string | null
}

export type ArchivedSession = {
  id: string
  archive: string
  stamp: string
  title: string | null
  cwd: string | null
  sizeBytes?: number
}

export type PairResponse = { clientId: string; info: HostInfo }

// ── What the plugin keeps in $.state ──

/** One account on a host, with its sessions. */
export type ConductorAccount = {
  account: RemoteAccount
  sessions: Array<RemoteSession>
  /** Its Remote Control servers; null on a server too old to say. */
  servers?: Array<RcServer> | null
  error: string | null
}

/** One paired host as last read. */
export type ConductorHost = {
  id: string
  label: string
  hostname: string
  address: string | null
  info: HostInfo | null
  accounts: Array<ConductorAccount>
  error: string | null
}

/** Every host, and when they were read. */
export type ConductorView = {
  isLoading: boolean
  hosts: Array<ConductorHost>
  updatedAt: number | null
  /** Made-up hosts, for screenshots (`/remote-control-cli-servers demo`). */
  isDemo?: boolean
}

/** What's selected in the pane: a host, an account or a session. */
export type ConductorSelection =
  | { kind: 'host'; hostId: string }
  | { kind: 'account'; hostId: string; account: string }
  | { kind: 'session'; hostId: string; account: string; sessionId: string }

/** The line under the header after an action. */
export type ConductorNote = { text: string; detail?: string; tone: 'success' | 'error' | 'info' }

/** Where a session runs, for the dialogs that act on one. */
export type ConductorTarget = { hostId: string; account: string; sessionId: string; title: string }

/** The dialog pane's content. */
export type ConductorDialog =
  | { kind: 'pair'; code: string; label: string; error: string | null; isBusy: boolean }
  | { kind: 'settings'; isBandOn: boolean; isDemo: boolean }
  | {
      kind: 'host'
      hostId: string
      label: string
      suffix: string
      isSuffixOn: boolean
      error: string | null
      isBusy: boolean
    }
  | { kind: 'newAccount'; hostId: string; name: string; error: string | null; isBusy: boolean }
  | { kind: 'renameAccount'; hostId: string; account: string; name: string; error: string | null; isBusy: boolean }
  | {
      kind: 'signIn'
      hostId: string
      account: string
      phase: 'confirmSwitch' | 'starting' | 'code' | 'submitting' | 'ended'
      isSwitch: boolean
      previousEmail: string | null
      loginId: string | null
      url: string | null
      code: string
      error: string | null
    }
  | {
      kind: 'newSession'
      hostId: string
      account: string
      /** A Remote Control server in the folder rather than a session. */
      isServer: boolean
      /** For a server: each session in the folder (`same-dir`) or in a git worktree of its own. */
      spawn: 'same-dir' | 'worktree'
      listing: DirListing | null
      name: string
      isNameTouched: boolean
      trustFolder: boolean
      error: string | null
      isBusy: boolean
    }
  | {
      kind: 'renameSession'
      target: ConductorTarget
      name: string
      running: boolean
      error: string | null
      isBusy: boolean
    }
  | {
      kind: 'move'
      target: ConductorTarget
      to: string
      plan: TransferPlan | null
      choices: Record<string, 'newer' | 'source' | 'destination' | 'merged'>
      merged: Record<string, string>
      merging: string | null
      replaceNewer: boolean
      afterwards: 'archive' | 'delete' | 'keep'
      resume: boolean
      progress: MoveProgress | null
      phase: 'form' | 'moving'
      error: string | null
    }
  | {
      kind: 'window'
      target: ConductorTarget
      windowId: string
      /** The last typed key (by number) the window's region posted that has been sent. */
      ack: number
      launch: LaunchResult | null
      screen: WindowScreen | null
      text: string
      error: string | null
      isGone: boolean
    }
  | {
      kind: 'confirm'
      title: string
      body: string
      confirmLabel: string
      isDanger: boolean
      action: ConductorConfirmAction
      error: string | null
      isBusy: boolean
    }

/** What a confirm dialog does when confirmed. */
export type ConductorConfirmAction =
  | { kind: 'stop'; target: ConductorTarget }
  | { kind: 'archive'; target: ConductorTarget }
  | { kind: 'deleteArchive'; hostId: string; account: string; id: string; archive: string; title: string }
  | { kind: 'restartAll'; hostId: string; account: string }
  | { kind: 'signOut'; hostId: string; account: string; running: number }
  | { kind: 'deleteAccount'; hostId: string; account: string }
  | { kind: 'removeHost'; hostId: string }
  | { kind: 'stopServer'; hostId: string; account: string; pid: number; folder: string; sessions: number }
  | {
      kind: 'restartServer'
      hostId: string
      account: string
      pid: number
      folder: string
      name: string | null
      spawn: string
      sessions: number
      /** `2.1.293 → 2.1.300` */
      versions: string
    }

declare module 'claude-code' {
  interface PluginState {
    'remote-control-cli-servers': {
      view: ConductorView
      selected: ConductorSelection | null
      /** Accounts (`<host id>/<account>`) whose archived sessions are shown, with them. */
      archived: Record<string, Array<ArchivedSession>>
      /** Accounts whose previous sessions are all shown, not the first 8. */
      showAll: Array<string>
      /** The action running now: `<key>:<action>`. */
      busy: string | null
      note: ConductorNote | null
      /** The ⋯ menu that's open (`hm-…`, `am-…`, `sm-…`). */
      openMenu: string | null
      dialog: ConductorDialog | null
      /** Whether the band above the prompt shows: the store's `band`, on unless turned off. */
      bandOn: boolean
      /** Whether the hosts pane is open, so the band's button closes it. */
      paneOpen: boolean
    }
  }
}
