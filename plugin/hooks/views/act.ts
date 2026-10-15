// What the views can ask for. register.tsx builds it, with `$` in its closures.

import type { Elements } from 'claude-code'
import type {
  ArchivedSession,
  ConductorConfirmAction,
  ConductorDialog,
  ConductorSelection,
  ConductorTarget,
} from '../../types'

/** The elements a view draws with: the surface's table. */
/**
 * The elements a view draws with (the surface's table), and which surface
 * draws them, as the engine says: the tables alone don't tell them apart.
 */
export type Ui = (Elements['terminal'] & { surface: 'terminal' }) | (Elements['desktop'] & { surface: 'desktop' })

export type Act = {
  refresh: () => void
  select: (selection: ConductorSelection | null) => void
  toggleArchived: (hostId: string, account: string) => void
  toggleShowAll: (hostId: string, account: string) => void
  dismissNote: () => void
  /** Opens the settings dialog. */
  openSettings: () => void
  /** Opens a row's ⋯ menu by its key, or closes the open one. */
  toggleMenu: (key: string | null) => void

  resume: (target: ConductorTarget) => void
  restart: (target: ConductorTarget) => void
  openClaude: (target: ConductorTarget, bridgeSessionId: string) => void
  /** Opens a Remote Control server's page on claude.ai. */
  openEnvironment: (hostId: string, url: string) => void
  openClaudeApp: (target: ConductorTarget, bridgeSessionId: string) => void
  openWindow: (target: ConductorTarget, windowId: string) => void
  restore: (hostId: string, account: string, archived: ArchivedSession) => void
  confirm: (action: ConductorConfirmAction) => void

  openDialog: (dialog: ConductorDialog) => void
  openNewSession: (hostId: string, account: string) => void
  /** Opens the dialog for a Remote Control server, in `folder` when given. */
  openNewServer: (hostId: string, account: string, folder: string | null) => void
  openSignIn: (hostId: string, account: string, isSwitch: boolean) => void
  openMove: (target: ConductorTarget) => void
}

/** What the dialog views can ask for. */
export type DialogAct = {
  close: () => void
  patch: (patch: Record<string, unknown>) => void
  submit: () => void
  /** Pair, host settings: remove the host. */
  removeHost: (hostId: string) => void
  /** Settings: the band above the prompt, and demo mode, each on or off at once. */
  setBand: (isOn: boolean) => void
  setDemo: (isOn: boolean) => void
  /** New session: go into a folder, or up. */
  browse: (path: string | null) => void
  /** Sign in: start (again), or open the page again. */
  startSignIn: () => void
  openUrl: (url: string) => void
  /** Move: pick a destination, merge a memory note. */
  moveTo: (account: string) => void
  merge: (path: string) => void
  /** Window: send keys, copy the attach command, open it in Terminal. */
  sendKeys: (keys: Array<{ key: string } | { text: string }>) => void
  /** The live Type field: each change goes to the window as it's typed; Enter sends Enter. */
  typeLive: (value: string) => void
  submitLive: () => void
  copyAttach: () => void
  openTerminal: () => void
  /** Switch account: sign out instead, without signing in again. */
  signOut: () => void
}
