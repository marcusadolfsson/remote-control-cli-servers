// Which running sessions a profile's Remote Control servers serve, so the pane
// can list them under their server, apart from the ones started from the CLI.

import type { RcServer, RemoteSession } from './wire'

export type SessionGroups = {
  /** Each server's sessions, keyed by its pid. */
  byServer: Map<number, Array<RemoteSession>>
  /** Everything else: sessions started from the CLI or here, and stopped ones. */
  rest: Array<RemoteSession>
}

/** Pure: `path` is `folder` or inside it (a server's worktrees live under its folder). */
function within(path: string, folder: string): boolean {
  const root = folder.endsWith('/') ? folder : `${folder}/`
  return path === folder || path.startsWith(root)
}

/**
 * Pure: the server serving `session`, if any: a running served session whose
 * folder is one server's folder, or inside it. The deepest folder wins when
 * servers nest.
 */
export function servingServer(session: RemoteSession, servers: ReadonlyArray<RcServer>): RcServer | undefined {
  const cwd = session.cwd
  if (!session.running || !session.served || !cwd) return undefined
  return servers
    .filter((server) => within(cwd, server.folder))
    .sort((a, b) => b.folder.length - a.folder.length)[0]
}

/**
 * Pure: splits `sessions` into each server's and the rest, keeping their order.
 * A served session whose server isn't listed stays in the rest, so it's never hidden.
 */
export function groupByServer(
  sessions: ReadonlyArray<RemoteSession>,
  servers: ReadonlyArray<RcServer> | null | undefined,
): SessionGroups {
  const byServer = new Map<number, Array<RemoteSession>>()
  const rest: Array<RemoteSession> = []
  for (const session of sessions) {
    const server = servingServer(session, servers ?? [])
    if (!server) {
      rest.push(session)
      continue
    }
    byServer.set(server.pid, [...(byServer.get(server.pid) ?? []), session])
  }
  return { byServer, rest }
}
