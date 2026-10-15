// The tools Claude gets: the host halves of the Remote Control Conductor Mac app's MCP
// tools, served by register.tsx. Listed as mcp__remote-control-cli-servers__<name>.

import type { RemoteSession } from './wire'

import { sessionTitle } from './format'

const profile = {
  type: 'string',
  description: 'An account on a host, written host/account ("atlas/marcus1").',
}
const session = { type: 'string', description: "The session's id, an id prefix of 8+ characters, or its exact title." }
const host = { type: 'string', description: 'A paired host, by its label or host name ("atlas").' }

const object = (properties: Record<string, unknown>, required: Array<string>) => ({
  type: 'object',
  properties,
  required,
})

export const TOOL_SPECS: ReadonlyArray<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: 'list_profiles',
    description:
      "Every paired host's Claude Code accounts (profiles), with the account each is signed in to and its session counts. Start here: a profile is written host/account. Sessions run in tmux with Remote Control on.",
    inputSchema: object({}, []),
  },
  {
    name: 'list_sessions',
    description:
      "A host profile's Claude Code sessions: title, folder, when, whether it's running, its Remote Control link, whether it waits on input, and whether it waits on a restart to take an installed update.",
    inputSchema: object(
      { profile, archived: { type: 'boolean', description: 'List archived sessions instead of the live ones.' } },
      ['profile'],
    ),
  },
  {
    name: 'host_info',
    description: "A host's machine: its name, Claude Code and tmux versions, and where its accounts live.",
    inputSchema: object({ host }, ['host']),
  },
  {
    name: 'list_folders',
    description: 'The folders in a folder on a host, to pick where a new session starts.',
    inputSchema: object({ host, path: { type: 'string', description: 'The folder to list; home when left out.' } }, [
      'host',
    ]),
  },
  {
    name: 'new_session',
    description:
      'Start a Claude Code session on a host, in its own tmux window with Remote Control on, so it shows up in the Claude apps. Reports anything it stopped at (attention), and the Remote Control name.',
    inputSchema: object(
      {
        profile,
        folder: { type: 'string', description: 'The folder on the host to start in, absolute or ~-relative.' },
        name: {
          type: 'string',
          description: "The session's name, shown in Remote Control and tmux. The folder's name when left out.",
        },
        trust_folder: {
          type: 'boolean',
          description:
            "Answer Claude's \"do you trust this folder?\" for it. Remote Control can't connect until it's answered. Default true.",
        },
      },
      ['profile', 'folder'],
    ),
  },
  {
    name: 'list_rc_servers',
    description:
      "A profile's Remote Control servers: `claude remote-control` running in a folder, so the Claude apps on the person's other devices can start new sessions there. Each with its folder, how sessions are placed (spawn: same-dir, or worktree for one each), how many it serves, whether it was started from here (only those can be stopped here) and its claude.ai page.",
    inputSchema: object({ profile }, ['profile']),
  },
  {
    name: 'start_rc_server',
    description:
      "Start a Remote Control server (`claude remote-control`) in a folder on a host, in its own tmux window, so the Claude apps can start new sessions in that folder. If one runs there already, says so and starts nothing. Reports anything it stopped at (attention), such as Remote Control's one-time question to turn it on, which someone has to answer in the window.",
    inputSchema: object(
      {
        profile,
        folder: { type: 'string', description: 'The folder on the host, absolute or ~-relative.' },
        name: { type: 'string', description: "What the Claude apps call it. The folder's name when left out." },
        spawn: {
          type: 'string',
          enum: ['same-dir', 'worktree'],
          description:
            'same-dir (the default): every session works in the folder. worktree: each in a git worktree of its own; the folder must be a git repository.',
        },
        trust_folder: {
          type: 'boolean',
          description: 'Answer its "Trust <folder>?" question with yes. Default true.',
        },
      },
      ['profile', 'folder'],
    ),
  },
  {
    name: 'stop_rc_server',
    description:
      'Stop a Remote Control server started from here, by its folder. The sessions it serves stop answering; starting a server in the folder again within a few hours brings them back.',
    inputSchema: object(
      { profile, folder: { type: 'string', description: 'The folder it serves, as list_rc_servers gives it.' } },
      ['profile', 'folder'],
    ),
  },
  {
    name: 'resume_session',
    description: 'Resume a session on a host, in tmux with Remote Control on. A running one is left as it is.',
    inputSchema: object({ profile, session }, ['profile', 'session']),
  },
  {
    name: 'restart_session',
    description:
      'Restart a running session on a host: it exits and comes back in the same conversation, on the Claude Code version now installed.',
    inputSchema: object({ profile, session }, ['profile', 'session']),
  },
  {
    name: 'restart_outdated',
    description:
      'Restart every running session of an account on a host that waits on a restart to take an installed Claude Code update, one at a time.',
    inputSchema: object({ profile }, ['profile']),
  },
  {
    name: 'stop_session',
    description:
      'Stop a running session on a host: Claude exits and its tmux window closes. The conversation stays, and can be resumed.',
    inputSchema: object({ profile, session }, ['profile', 'session']),
  },
  {
    name: 'rename_session',
    description: 'Rename a session on a host. The name follows it to Remote Control and tmux.',
    inputSchema: object({ profile, session, name: { type: 'string', description: 'The new name.' } }, [
      'profile',
      'session',
      'name',
    ]),
  },
  {
    name: 'read_window',
    description:
      "What a running session's tmux window shows right now, as text: to see why a session didn't start cleanly, or what it's asking.",
    inputSchema: object({ profile, session }, ['profile', 'session']),
  },
  {
    name: 'send_to_window',
    description:
      "Type into a running session's tmux window: named keys and literal text, in order. Returns what the window shows afterwards.",
    inputSchema: object(
      {
        profile,
        session,
        keys: {
          type: 'array',
          description:
            'What to send, in order: {"key": "Enter"} (Enter, Escape, Tab, Up, Down, Left, Right, BSpace, C-c) or {"text": "literal"}.',
          items: { type: 'object' },
        },
      },
      ['profile', 'session', 'keys'],
    ),
  },
  {
    name: 'open_in_claude',
    description:
      "Open a host session's Remote Control conversation on claude.ai in this Mac's browser. Also returns the link, for the phone.",
    inputSchema: object({ profile, session }, ['profile', 'session']),
  },
  {
    name: 'switch_account',
    description:
      "Switch a host profile to another Claude account (personal, work, a client's): its running sessions stop, it signs out, and a sign-in page opens in this Mac's browser. Sign in there as the other account, then pass the code the page shows to finish_sign_in; the same sessions then resume under the new account. Nothing moves.",
    inputSchema: object({ profile }, ['profile']),
  },
  {
    name: 'sign_in',
    description:
      "Start signing a host profile in (one that's signed out): a sign-in page opens in this Mac's browser. Then pass the code the page shows to finish_sign_in.",
    inputSchema: object({ profile }, ['profile']),
  },
  {
    name: 'finish_sign_in',
    description:
      'Finish a switch_account or sign_in: hand over the code the sign-in page showed. Says which account the profile is now signed in to, and how many sessions are resuming.',
    inputSchema: object(
      {
        profile,
        login_id: { type: 'string', description: 'The login_id switch_account or sign_in returned.' },
        code: { type: 'string', description: 'The code the sign-in page showed after signing in.' },
      },
      ['profile', 'login_id', 'code'],
    ),
  },
  {
    name: 'plan_move',
    description:
      'What moving a session to another account on the same host would do: the files it copies or replaces, and the memory notes both sides changed (with both texts), each needing a decision in move_session.',
    inputSchema: object(
      {
        profile,
        session,
        to: { type: 'string', description: 'Another account on the same host ("marcus2" or "atlas/marcus2").' },
      },
      ['profile', 'session', 'to'],
    ),
  },
  {
    name: 'move_session',
    description:
      'Move a session to another account on the same host: transcript, subagents, file history and plans, with project memory merged. Anything replaced is backed up. Call plan_move first.',
    inputSchema: object(
      {
        profile,
        session,
        to: { type: 'string', description: 'Another account on the same host.' },
        memory: {
          type: 'object',
          description:
            'One decision per memory note plan_move lists as a conflict, by its path: "source", "destination", "newer", or {"merged": "<text>"}.',
        },
        afterwards: {
          type: 'string',
          enum: ['archive', 'delete', 'keep'],
          description:
            'What happens to the copy left behind: archive (default; can be restored), delete (once the moved copy checks out), or keep.',
        },
        resume: {
          type: 'boolean',
          description: 'Resume it under the destination afterwards, with Remote Control on. Default true.',
        },
        replace_newer: {
          type: 'boolean',
          description: "Go ahead although the destination's copy is newer. Default false.",
        },
      },
      ['profile', 'session', 'to'],
    ),
  },
  {
    name: 'archive_session',
    description:
      "Archive a session on a host: take it out of the account's list, compressed, so it can be restored later.",
    inputSchema: object({ profile, session }, ['profile', 'session']),
  },
  {
    name: 'restore_session',
    description: 'Restore an archived session, so the account lists it again.',
    inputSchema: object(
      {
        profile,
        session: {
          type: 'string',
          description: "The archived session's id, an id prefix of 8+ characters, or its title.",
        },
        archive: {
          type: 'string',
          description: 'Which archive of it, as list_sessions with archived=true shows it. The latest when left out.',
        },
      },
      ['profile', 'session'],
    ),
  },
  {
    name: 'delete_archive',
    description: "Delete one archive of a session on a host for good, freeing its space. Can't be undone.",
    inputSchema: object(
      {
        profile,
        session: {
          type: 'string',
          description: "The archived session's id, an id prefix of 8+ characters, or its title.",
        },
        archive: { type: 'string', description: 'Which archive of it, as list_sessions with archived=true shows it.' },
      },
      ['profile', 'session', 'archive'],
    ),
  },
]

/** A session as the tools report it. */
export function sessionJson(s: RemoteSession) {
  return {
    id: s.id,
    title: sessionTitle(s),
    folder: s.cwd,
    updated: s.updatedAt,
    running: s.running,
    waitingForInput: s.waiting || undefined,
    remoteControl: s.remoteControl,
    link: s.bridgeSessionId ? `https://claude.ai/code/${s.bridgeSessionId}` : undefined,
    claudeVersion: s.claudeVersion ?? undefined,
    updatePending: s.updatePending || undefined,
    installedVersion: s.updatePending ? (s.installedVersion ?? undefined) : undefined,
    window: s.window?.windowId,
    empty: s.empty || undefined,
    sizeBytes: s.sizeBytes,
  }
}

/** move_session's memory decisions in the server's form; or which paths are wrong. */
export function toolDecisions(
  memory: Record<string, unknown> | undefined,
  conflictPaths: ReadonlyArray<string>,
  newerOf: (path: string) => 'source' | 'destination',
): { decisions: Record<string, unknown> } | { error: string } {
  const given = memory ?? {}
  const extra = Object.keys(given).filter((p) => !conflictPaths.includes(p))
  if (extra.length)
    return {
      error: `These aren't memory conflicts in this move: ${extra.join(', ')}. plan_move lists the ones that are.`,
    }
  const missing = conflictPaths.filter((p) => !(p in given))
  if (missing.length) {
    return {
      error: `Both sides changed these memory notes, and each needs a decision in memory ("source", "destination", "newer", or {"merged": "..."}): ${missing.join(', ')}.`,
    }
  }
  const decisions: Record<string, unknown> = {}
  for (const path of conflictPaths) {
    const choice = given[path]
    if (choice === 'source' || choice === 'destination') decisions[path] = { take: choice }
    else if (choice === 'newer') decisions[path] = { take: newerOf(path) }
    else if (typeof choice === 'object' && choice && typeof (choice as { merged?: unknown }).merged === 'string') {
      decisions[path] = { take: 'merged', text: (choice as { merged: string }).merged }
    } else
      return { error: `The decision for ${path} isn't one of "source", "destination", "newer" or {"merged": "..."}.` }
  }
  return { decisions }
}
