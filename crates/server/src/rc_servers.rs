//! Remote Control servers: `claude remote-control` running in a folder, so
//! the Claude apps can start new sessions there, on this machine, from
//! another device.
//!
//! The server finds them in the process table, wherever they were started:
//! a `claude` whose first argument is `remote-control`, in its folder, with
//! the account's `CLAUDE_CONFIG_DIR` (none for the stock install). The
//! sessions one serves are its children, each registered like any other
//! session but started for Remote Control (`entrypoint` `sdk-cli`).
//!
//! It starts one in a tmux window of its own, tagged `@aip_rc` with the
//! server's pid, and only those can be shown, typed into and stopped from the
//! app. Starting one answers its "Trust <folder>? [y/N]" question with yes
//! when asked to, unless the question says the folder's settings pre-approve
//! anything; Remote Control's own one-time "Enable Remote Control? (y/n)" is
//! always left for someone to answer in the window.

use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use conductor_core::api::{Attention, RcServer, StartRcServerResult, TmuxWindow};
use conductor_core::registry::RegistryEntry;

use crate::accounts::AccountDir;
use crate::error::ApiError;
use crate::process_info;
use crate::tmux::Tmux;

/// The window tag naming the server's pid.
pub const TAG: &str = "@aip_rc";
/// The `--spawn` modes the app may choose. `session` (one session only) is
/// left out: a server that serves one session is what Resume already does.
pub const SPAWN_MODES: [&str; 2] = ["same-dir", "worktree"];

const SETTLE_TIMEOUT: Duration = Duration::from_secs(15);
const STOP_TIMEOUT: Duration = Duration::from_secs(8);
const POLL: Duration = Duration::from_millis(250);

/// A `claude remote-control` command line's flags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Flags {
    pub name: Option<String>,
    pub spawn: String,
}

/// Pure: the flags of `argv` when it's `claude remote-control …`, run as
/// `claude` (on the `PATH`, or `~/.local/bin/claude`) or as one of its
/// installed versions (`…/claude/versions/2.1.288`).
pub fn parse_command(argv: &[String]) -> Option<Flags> {
    let program = Path::new(argv.first()?);
    let is_claude = program.file_name().is_some_and(|name| name == "claude")
        || program
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|dir| dir == "versions");
    if !is_claude || argv.get(1).map(String::as_str) != Some("remote-control") {
        return None;
    }
    let mut flags = Flags {
        name: None,
        spawn: "same-dir".into(),
    };
    let mut rest = argv[2..].iter();
    while let Some(arg) = rest.next() {
        let (flag, inline) = match arg.split_once('=') {
            Some((flag, value)) => (flag, Some(value.to_owned())),
            None => (arg.as_str(), None),
        };
        let mut value = || inline.clone().or_else(|| rest.next().cloned());
        match flag {
            "--name" => flags.name = value(),
            "--spawn" => {
                if let Some(spawn) = value() {
                    flags.spawn = spawn;
                }
            }
            _ => {}
        }
    }
    Some(flags)
}

/// Pure: a session a Remote Control server started and serves.
pub fn is_served(entry: &RegistryEntry) -> bool {
    entry.entrypoint.as_deref() == Some("sdk-cli")
}

/// What a server's window says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Screen {
    /// Connected, with its page on claude.ai when the screen shows it.
    Connected { url: Option<String> },
    /// "Trust <folder>? [y/N]", and whether it says the folder's settings
    /// pre-approve anything.
    TrustQuestion { preapproves: bool },
    /// Remote Control's one-time "Enable Remote Control? (y/n)".
    EnableQuestion,
    /// None of those yet.
    Starting,
}

/// Pure: read a server's window.
pub fn read_screen(screen: &str) -> Screen {
    let lines: Vec<&str> = screen
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect();
    let last = lines.last().copied().unwrap_or_default();
    if last.starts_with("Trust ") && last.ends_with("[y/N]") {
        let question = screen
            .rfind("Quick safety check")
            .map_or(screen, |at| &screen[at..]);
        return Screen::TrustQuestion {
            preapproves: question.to_lowercase().contains("pre-approve"),
        };
    }
    if last.contains("Enable Remote Control?") {
        return Screen::EnableQuestion;
    }
    let connected = lines
        .iter()
        .rev()
        .take(12)
        .any(|line| line.contains("Connected") && !line.contains("Disconnected"));
    if connected {
        let url = screen
            .split_whitespace()
            .find(|word| word.starts_with("https://claude.ai/code?environment="))
            .map(str::to_owned);
        return Screen::Connected { url };
    }
    Screen::Starting
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Whether process `pid` runs as `account`: its `CLAUDE_CONFIG_DIR` is the
/// account's, or, for the stock install, it has none.
fn runs_as(pid: i32, account: &AccountDir) -> bool {
    match process_info::environment_var(pid, "CLAUDE_CONFIG_DIR") {
        Some(dir) if !dir.is_empty() => same_dir(Path::new(&dir), &account.dir),
        _ => account.is_default,
    }
}

/// `account`'s Remote Control servers, by folder.
pub fn list(tmux: &Tmux, account: &AccountDir) -> Vec<RcServer> {
    let all = process_info::all();
    let ours: std::collections::HashMap<i32, TmuxWindow> = tmux
        .tagged(TAG)
        .into_iter()
        .filter_map(|(window, pid)| Some((pid.parse().ok()?, window)))
        .collect();
    let mut servers: Vec<RcServer> = all
        .iter()
        .filter_map(|process| Some((process, parse_command(&process.argv)?)))
        .filter(|(process, _)| runs_as(process.pid, account))
        .filter_map(|(process, flags)| {
            let folder = process_info::working_dir(process.pid)?;
            let sessions = all
                .iter()
                .filter(|child| child.ppid == process.pid)
                .filter(|child| child.argv.iter().any(|arg| arg == "--sdk-url"))
                .count();
            let window = ours.get(&process.pid).cloned();
            let screen = window
                .as_ref()
                .and_then(|window| tmux.capture(&window.pane_id))
                .map(|text| (read_screen(&text), text));
            Some(RcServer {
                pid: process.pid,
                folder: folder.display().to_string(),
                name: flags.name,
                spawn: flags.spawn,
                sessions: u32::try_from(sessions).unwrap_or(u32::MAX),
                window,
                environment_url: match &screen {
                    Some((Screen::Connected { url }, _)) => url.clone(),
                    _ => None,
                },
                attention: screen.and_then(|(screen, text)| attention(&screen, &text)),
                claude_version: process_info::executable(process.pid)
                    .as_deref()
                    .and_then(version_in_path),
                update_pending: false,
                installed_version: None,
            })
        })
        .collect();
    servers.sort_by(|a, b| a.folder.cmp(&b.folder));
    servers
}

/// Pure: the version a native Claude Code install's program is,
/// `…/claude/versions/<version>`. None for any other program.
pub fn version_in_path(program: &Path) -> Option<String> {
    let parent = program.parent()?.file_name()?;
    let version = program.file_name()?.to_str()?;
    (parent == "versions" && version.starts_with(|c: char| c.is_ascii_digit()))
        .then(|| version.to_owned())
}

/// Mark the servers running an older Claude Code than `installed`.
pub fn mark_updates(servers: &mut [RcServer], installed: &str) {
    for server in servers {
        server.update_pending = server
            .claude_version
            .as_deref()
            .is_some_and(|running| crate::sessions::newer_version(installed, running));
        server.installed_version = server.update_pending.then(|| installed.to_owned());
    }
}

/// What a server's window is waiting for someone to answer, if anything.
fn attention(screen: &Screen, text: &str) -> Option<Attention> {
    match screen {
        Screen::Connected { .. } | Screen::Starting => None,
        Screen::TrustQuestion { preapproves: true } => Some(Attention {
            kind: "trustPermissions".into(),
            text: last_lines(text, 8),
        }),
        Screen::TrustQuestion { preapproves: false } => Some(Attention {
            kind: "trustPrompt".into(),
            text: "Claude is asking whether to trust this folder. The server connects once someone answers it in the window.".into(),
        }),
        Screen::EnableQuestion => Some(Attention {
            kind: "enableRemoteControl".into(),
            text: "Claude is asking to turn on Remote Control for this account, once. Answer it in the window.".into(),
        }),
    }
}

/// What starting a server needs.
pub struct Start<'a> {
    pub account: &'a AccountDir,
    pub claude: &'a Path,
    pub folder: &'a Path,
    pub name: Option<String>,
    pub spawn: String,
    pub window_name: String,
    pub trust_folder: bool,
}

/// Pure: the command a server's window runs, `env` setting the account's
/// config dir first as for a session.
pub fn server_argv(start: &Start) -> Vec<String> {
    let mut argv = vec!["/usr/bin/env".to_owned()];
    if start.account.is_default {
        argv.extend(["-u".to_owned(), "CLAUDE_CONFIG_DIR".to_owned()]);
    } else {
        argv.push(format!(
            "CLAUDE_CONFIG_DIR={}",
            start.account.config_dir().display()
        ));
    }
    argv.extend([
        start.claude.display().to_string(),
        "remote-control".to_owned(),
    ]);
    if let Some(name) = start
        .name
        .as_deref()
        .map(|name| name.trim_start_matches(['-', ' ']))
        .filter(|name| !name.is_empty())
    {
        argv.extend(["--name".to_owned(), name.to_owned()]);
    }
    argv.extend(["--spawn".to_owned(), start.spawn.clone()]);
    argv
}

/// Start a server in `start.folder`, or find the one running there.
pub fn start(tmux: &Tmux, start: &Start) -> Result<StartRcServerResult, ApiError> {
    if let Some(server) = list(tmux, start.account)
        .into_iter()
        .find(|server| same_dir(Path::new(&server.folder), start.folder))
    {
        return Ok(StartRcServerResult {
            attach_command: server
                .window
                .as_ref()
                .map(|window| tmux.attach_command(window)),
            server,
            already_running: true,
        });
    }
    if let Err(err) = start
        .account
        .finish_setup(|| crate::hostinfo::claude_version(start.claude))
    {
        eprintln!("could not mark {} set up: {err}", start.account.name);
    }
    let launched = tmux
        .open_window(
            &start.window_name,
            &start.folder.display().to_string(),
            &server_argv(start),
        )
        .map_err(ApiError::internal)?;
    let window_id = &launched.window.window_id;
    let _ = tmux.tag(window_id, "@aip_account", &start.account.name);
    let _ = tmux.tag(window_id, TAG, &launched.pane_pid.to_string());
    let pane = &launched.window.pane_id;
    let deadline = Instant::now() + SETTLE_TIMEOUT;
    let mut answered = false;
    let mut last_screen = String::new();
    let mut waiting_on = None;
    while Instant::now() < deadline {
        let Some(screen) = tmux.capture(pane) else {
            return Err(exited(&last_screen));
        };
        let read = read_screen(&screen);
        // Acted on only once it has finished drawing: unchanged since the last look.
        let drawn = screen == last_screen;
        match &read {
            Screen::Connected { .. } => {
                waiting_on = None;
                break;
            }
            Screen::TrustQuestion { preapproves: false } if start.trust_folder && !answered => {
                if drawn {
                    tmux.type_text(pane, "y").map_err(ApiError::internal)?;
                    tmux.press(pane, "Enter").map_err(ApiError::internal)?;
                    answered = true;
                }
            }
            Screen::TrustQuestion { .. } | Screen::EnableQuestion if drawn => {
                waiting_on = attention(&read, &screen);
                break;
            }
            _ => {}
        }
        last_screen = screen;
        thread::sleep(POLL);
    }
    let server = list(tmux, start.account)
        .into_iter()
        .find(|server| server.pid == launched.pane_pid)
        .map(|server| RcServer {
            attention: server.attention.or_else(|| waiting_on.clone()),
            ..server
        })
        .unwrap_or_else(|| RcServer {
            pid: launched.pane_pid,
            folder: start.folder.display().to_string(),
            name: start.name.clone(),
            spawn: start.spawn.clone(),
            sessions: 0,
            window: Some(launched.window.clone()),
            environment_url: None,
            attention: waiting_on.clone().or_else(|| {
                Some(Attention {
                    kind: "waiting".into(),
                    text: last_lines(&last_screen, 6),
                })
            }),
            claude_version: None,
            update_pending: false,
            installed_version: None,
        });
    Ok(StartRcServerResult {
        attach_command: Some(tmux.attach_command(&launched.window)),
        server,
        already_running: false,
    })
}

/// Stop server `pid` of `account`, which must run in a window this server
/// opened: Ctrl+C in it, as someone at its keyboard would, which leaves its
/// sessions resumable for a few hours. Answers whether it was running.
pub fn stop(tmux: &Tmux, account: &AccountDir, pid: i32) -> Result<bool, ApiError> {
    let Some(server) = list(tmux, account)
        .into_iter()
        .find(|server| server.pid == pid)
    else {
        return Ok(false);
    };
    let Some(window) = server.window else {
        return Err(ApiError::conflict(
            "not_started_here",
            "That server wasn't started from here: stop it where it runs, with Ctrl+C.",
        ));
    };
    tmux.press(&window.pane_id, "C-c")
        .map_err(ApiError::internal)?;
    let deadline = Instant::now() + STOP_TIMEOUT;
    while Instant::now() < deadline {
        if !is_server(pid) {
            let _ = tmux.kill_window(&window.window_id);
            return Ok(true);
        }
        thread::sleep(POLL);
    }
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
    thread::sleep(Duration::from_secs(1));
    if is_server(pid) {
        return Err(ApiError::conflict(
            "server_did_not_stop",
            format!("The Remote Control server (process {pid}) didn't stop."),
        ));
    }
    let _ = tmux.kill_window(&window.window_id);
    Ok(true)
}

/// Whether `pid` is still a `claude remote-control`.
fn is_server(pid: i32) -> bool {
    process_info::argv(pid).is_some_and(|argv| parse_command(&argv).is_some())
}

fn last_lines(screen: &str, count: usize) -> String {
    let lines: Vec<&str> = screen
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .collect();
    lines[lines.len().saturating_sub(count)..].join("\n")
}

fn exited(last_screen: &str) -> ApiError {
    let shown = last_lines(last_screen, 6);
    ApiError::conflict(
        "launch_failed",
        if shown.is_empty() {
            "The Remote Control server exited as soon as it started. Try `claude remote-control` in a terminal on the host to see why.".to_owned()
        } else {
            format!(
                "The Remote Control server exited as soon as it started. It last showed:\n{shown}"
            )
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn argv(line: &str) -> Vec<String> {
        line.split(' ').map(str::to_owned).collect()
    }

    #[test]
    fn reads_the_version_off_a_native_install_program() {
        let version = |path: &str| version_in_path(Path::new(path));
        assert_eq!(
            version("/home/m/.local/share/claude/versions/2.1.293").as_deref(),
            Some("2.1.293")
        );
        assert_eq!(version("/usr/bin/node"), None);
        assert_eq!(version("/x/versions/latest"), None);
    }

    #[test]
    fn marks_servers_on_an_older_version() {
        let server = |version: Option<&str>| RcServer {
            pid: 1,
            folder: "/w".into(),
            name: None,
            spawn: "same-dir".into(),
            sessions: 0,
            window: None,
            environment_url: None,
            attention: None,
            claude_version: version.map(str::to_owned),
            update_pending: false,
            installed_version: None,
        };
        let mut servers = [
            server(Some("2.1.293")),
            server(Some("2.1.300")),
            server(None),
        ];
        mark_updates(&mut servers, "2.1.300");
        assert!(servers[0].update_pending);
        assert_eq!(servers[0].installed_version.as_deref(), Some("2.1.300"));
        assert!(!servers[1].update_pending && servers[1].installed_version.is_none());
        assert!(!servers[2].update_pending);
    }

    #[test]
    fn reads_remote_control_command_lines() {
        assert_eq!(
            parse_command(&argv(
                "/home/m/.local/bin/claude remote-control --name rc-spike --spawn same-dir"
            )),
            Some(Flags {
                name: Some("rc-spike".into()),
                spawn: "same-dir".into()
            })
        );
        assert_eq!(
            parse_command(&argv("claude remote-control --spawn=worktree")),
            Some(Flags {
                name: None,
                spawn: "worktree".into()
            })
        );
        assert_eq!(
            parse_command(&argv(
                "/home/m/.local/share/claude/versions/2.1.288 remote-control"
            )),
            Some(Flags {
                name: None,
                spawn: "same-dir".into()
            })
        );
        // A session it serves, an interactive session with Remote Control, something else.
        assert_eq!(
            parse_command(&argv(
                "/home/m/.local/share/claude/versions/2.1.288 --print --sdk-url https://x"
            )),
            None
        );
        assert_eq!(parse_command(&argv("claude --remote-control Deploy")), None);
        assert_eq!(parse_command(&argv("/usr/bin/vim remote-control")), None);
    }

    const TRUST: &str = "Remote Control starts Claude Code sessions in this folder, driven from your other devices:
  /tmp/rc-spike
Quick safety check: is this a project you created or one you trust? Sessions started here can read, edit, and execute files, and this folder's project settings
(hooks, MCP servers, permission rules, helper commands) apply to them.
Security guide: https://code.claude.com/docs/en/security
Trust /tmp/rc-spike? [y/N]
";

    const CONNECTED: &str = "Trust /tmp/rc-spike? [y/N] y
·✔︎· Connected · rc-spike · master
    Capacity: 1/32 · New sessions will be created in the current directory
    rc-spike
Continue coding in the Claude mobile app or https://claude.ai/code?environment=env_01H8XTMyoASFRcoyjEph9dbb
Or ask Claude to work in this folder from your projects on claude.ai
space to show QR code · w to toggle spawn mode
";

    #[test]
    fn reads_what_a_server_window_shows() {
        assert_eq!(
            read_screen(TRUST),
            Screen::TrustQuestion { preapproves: false }
        );
        assert_eq!(
            read_screen(&TRUST.replace(
                "apply to them.",
                "apply to them. Its settings pre-approve Bash(rm:*)."
            )),
            Screen::TrustQuestion { preapproves: true }
        );
        assert_eq!(
            read_screen(CONNECTED),
            Screen::Connected {
                url: Some("https://claude.ai/code?environment=env_01H8XTMyoASFRcoyjEph9dbb".into())
            }
        );
        assert_eq!(
            read_screen("Remote Control lets you…\nEnable Remote Control? (y/n)\n"),
            Screen::EnableQuestion
        );
        assert_eq!(read_screen("Starting…\n"), Screen::Starting);
        assert_eq!(
            read_screen("·✗· Disconnected · reconnecting\n"),
            Screen::Starting
        );
    }

    #[test]
    fn a_window_runs_the_server_as_the_account() {
        let account = AccountDir {
            name: "Misc".into(),
            dir: PathBuf::from("/home/m/.claude-accounts/Misc"),
            is_default: false,
        };
        let start = Start {
            account: &account,
            claude: Path::new("/home/m/.local/bin/claude"),
            folder: Path::new("/home/m/proj"),
            name: Some("-proj".into()),
            spawn: "worktree".into(),
            window_name: "rc proj".into(),
            trust_folder: true,
        };
        assert_eq!(
            server_argv(&start).join(" "),
            "/usr/bin/env CLAUDE_CONFIG_DIR=/home/m/.claude-accounts/Misc /home/m/.local/bin/claude remote-control --name proj --spawn worktree"
        );
    }

    #[test]
    fn served_sessions_are_the_ones_started_for_remote_control() {
        let entry = |entrypoint: &str| RegistryEntry {
            pid: 1,
            session_id: None,
            cwd: None,
            status: None,
            kind: None,
            entrypoint: Some(entrypoint.into()),
            tmux: None,
            name: None,
            name_source: None,
            bridge_session_id: None,
            proc_start: None,
            pid_domain: None,
            started_at: None,
            version: None,
        };
        assert!(is_served(&entry("sdk-cli")));
        assert!(!is_served(&entry("cli")));
    }
}
