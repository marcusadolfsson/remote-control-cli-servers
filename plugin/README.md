# Remote Control CLI Servers

The Claude Code half of [Remote Control CLI Servers](https://github.com/marcusadolfsson/remote-control-cli-servers):
your Linux machines' Claude Code accounts and sessions, in a pane beside the conversation, in the
terminal or the Claude desktop app's Code tab. Pair hosts, see their profiles (Claude accounts) and
sessions, start, resume, restart, stop, rename, move, archive and restore sessions, answer what a
session is asking in its tmux window, and sign profiles in, out or over to another account. Claude
gets the same as tools.

## Requirements

- **macOS**, with Claude Code 2.1.287 or later (the desktop app's own Claude Code loads it too). The
  plugin uses tools macOS ships with; it doesn't run on Linux or Windows.
- **On each Linux host**, `remote-control-conductor-server`, from this project's
  [releases](https://github.com/marcusadolfsson/remote-control-cli-servers/releases), installed and
  set up as the project's README describes. The plugin does nothing until a host is paired.
- **A network your Mac and the hosts share**: the same Tailscale tailnet, a WireGuard or other VPN,
  or the same LAN. The plugin connects to each host directly on port 7443; nothing is relayed.

## Use

- `/remote-control-cli-servers` opens the pane, with Refresh, Pair a host and Settings in the ⋯
  menu at its top: every host as a card, its profiles and their
  sessions. Each has a ⋯ menu of its actions, each with a letter that presses it while the menu is
  open. The pane reads the hosts again every 15 s while it's open.
- **The band above the prompt** shows the hosts in one line: how many sessions are waiting for
  you, then each host's running sessions, or that it's offline. Press `1` in an empty prompt to
  open the pane (or close it), or the waiting session's tmux window when only one is waiting.
  While the band is on, the plugin reads the hosts every 30 s. Turn it off in **Settings**, in
  the ⋯ menu at the top of the pane, which also turns demo mode on and off.
- `/remote-control-cli-servers pair` opens the pane with the pairing dialog.
- `/remote-control-cli-servers text` answers as text, for `claude -p`.
- `/remote-control-cli-servers demo` swaps in three made-up hosts, for screenshots; again to swap back.
- Tools for Claude, as `mcp__remote-control-cli-servers__<name>`: `list_profiles`, `list_sessions`,
  `host_info`, `list_folders`, `new_session`, `resume_session`, `restart_session`,
  `restart_outdated`, `stop_session`, `rename_session`, `read_window`, `send_to_window`,
  `open_in_claude`, `sign_in`, `switch_account`, `finish_sign_in`, `plan_move`, `move_session`,
  `archive_session`, `restore_session`, `delete_archive`, `list_rc_servers`, `start_rc_server`,
  `stop_rc_server`.

## What it runs, reads and sends

Everything here goes to your own Linux hosts and nowhere else: the plugin sends nothing to
Anthropic, to the plugin's author or to any other server. Below is every way it reaches outside
Claude Code, all from `hooks/register.tsx`.

### Why it runs programs instead of using Claude Code's HTTP call

The server on each host uses a self-signed certificate, which the plugin trusts only after checking
it against the fingerprint in the pairing code. Claude Code's own HTTP call (`$.http.fetch`) can
only trust certificates from the public certificate authorities, and it has no way to pin a key. So
the plugin talks to your hosts through macOS's own `curl`, pinned to each host's public key.

Each host's access token lives in the macOS login Keychain. You never see or type it: the host
issues it when you pair, and a script writes it straight into the Keychain. Nothing asks you for it,
so the plugin has no `user_config` option for it. The scripts read the token from the Keychain and
hand it to `curl` on stdin. It never enters the plugin's own code, a command line, its store or a
log.

### The scripts

`/bin/sh` runs only these four scripts, which ship in the plugin's `scripts/` folder. Each is
named at its call by a fixed path under the plugin's folder (`$.plugin.root`), and each says at its
top what it does:

| Script | Arguments | What it does |
|---|---|---|
| `scripts/pin.sh` | address, fingerprint | Fetches the host's certificate (a GET of `/v1/ping`, with no token), checks its SHA-256 against the pairing code's fingerprint, and prints its public key's hash to pin to. Uses `curl`, `awk`, `openssl`, `shasum`, `base64`. |
| `scripts/request.sh` | host id, key hash, URL, method, JSON body, seconds | One request to a paired host's API: reads that host's token from the Keychain (`security`) and sends the request with `curl`, pinned to the key. |
| `scripts/pair.sh` | address, key hash, JSON body, host id | Pairs: sends the pairing code's one-time secret and your Mac's name to the host, and writes the token it answers with into the Keychain (`jq`, `security`). |
| `scripts/forget-token.sh` | host id | Deletes that host's token from the Keychain when you remove the host. |

The arguments differ from call to call (a host's address, a request's path and body), so the
directory can't read the whole command off the source. Nothing else runs under `/bin/sh`.

### The other programs, each by a fixed path

| Call | When | What it does |
|---|---|---|
| `/usr/sbin/scutil --get ComputerName` | Pairing | Reads your Mac's name, which the host shows in its list of paired clients. |
| `/usr/bin/open <url>` | You choose Open on claude.ai, a sign-in, or Open in Claude app | Opens a session's `https://claude.ai/code/…` page, a sign-in page a host hands over (only on claude.com, claude.ai, platform.claude.com or console.anthropic.com), or `claude://code/<session>` in the Claude desktop app. |
| `/usr/bin/osascript` | You choose Open in Terminal | Opens Terminal running `ssh -t <host> 'tmux attach -t <session> ; select-window -t @<n>'`, so you can watch a session's tmux window. The host name and the tmux command are checked against strict patterns first. |
| `/usr/bin/env -u CLAUDE_CONFIG_DIR "/Applications/Remote Control Conductor.app/…/remote-control-conductor" mcp` | You choose Open in Claude app, and that Mac app is installed | Makes one MCP call (`open_in_claude`) to the Remote Control Conductor Mac app, a separate app by the same author (not a plugin), which knows which Claude desktop app is signed in as the session's account. It runs on your Mac and exits. Without that app, `open claude://…` is used instead. |

### What it reads, and where that goes

- **Its own store** (`$.store`, under `~/.claude`): the hosts you paired (name, addresses,
  certificate fingerprint, no token), each host's public-key hash, and the two settings (the band, demo mode).
- **The Mac app's host list**, `~/Library/Application Support/ai-profiles/remote-hosts.json`, if
  the Remote Control Conductor Mac app is installed (`$.fs.read`), so hosts paired there appear too.
  It holds the same kind of entries: names, addresses and fingerprints. The addresses are what the
  scripts connect to. Nothing in the file is sent anywhere.
- **The conversation**: only calls to this plugin's own tools. The `tool.call` hook matches only
  `mcp__remote-control-cli-servers__*` and answers those calls itself, so it never sees, changes
  or stands in for any other tool. What Claude passes to these tools goes to the host it names, as
  the matching request: for example a folder for `new_session`, a title for `rename_session`, the
  text for `send_to_window`.

### What it sends

Only to your paired hosts, over pinned HTTPS with that host's token: the requests the pane and the
tools make (list, start, resume, stop, rename, move or archive sessions, read or type into a tmux
window, sign a profile in or out, start or stop a Remote Control server in a folder), and, while the band is on, a read of each host's sessions every
30 seconds. When pairing, it also sends the one-time secret from the pairing
code and your Mac's name.

### Hooks

- `session.start`: registers the command and the tools, and starts a 3-second timer that re-reads
  the hosts while the pane is open (every 15 s), or every 30 s for the band, or not at all when the
  band is off and the pane is closed.
- `command.run` (`/remote-control-cli-servers` only), `tool.call` (its own tools only), and
  `ui.render`, `ui.message` and `ui.close` for its own two panes.
- `ui.render` for `AbovePrompt`: draws the band, beside any other plugin's band, which it passes on
  and keeps.

It hooks no network or process event. The tests (`tests/conductor.test.tsx`) do hook `process.run`,
but only to stand in for a host, answering `scripts/pin.sh` and `scripts/request.sh`. Tests don't
run in a session.

## Install

```sh
claude plugin marketplace add marcusadolfsson/remote-control-cli-servers
claude plugin install remote-control-cli-servers@remote-control-cli-servers
```

Or load it from a checkout for one session: `claude --plugin-dir plugin`.

## Develop

- `claude plugin validate --strict plugin`: what it hooks and calls, and anything the engine would
  refuse.
- `claude plugin test plugin`: the helpers' unit tests, and the panes and dialogs against a fake host
  on the terminal and the desktop.
- Everything that calls `$` is in `hooks/register.tsx` (the engine reads the calls off its source);
  the views are in `hooks/views/`, the pure helpers in `hooks/lib/`.
