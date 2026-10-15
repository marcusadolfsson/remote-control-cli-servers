// Another Mac sharing its Remote Control servers (Remote Control Conductor's
// "Share this Mac"): it offers only those, no sessions, moves or sign-ins.

import type { HostInfo } from './wire'

/** Pure: whether a host is a shared Mac. Its app says so in its version. */
export function isMacHost(info: HostInfo | null | undefined): boolean {
  return info?.serverVersion.endsWith('(Mac)') ?? false
}
