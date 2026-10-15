//! Bringing back the sessions that were running when the machine rebooted.
//!
//! Restarting the server leaves tmux, and every Claude in it, running. A
//! reboot, or tmux itself going away, ends them all. So the server keeps a
//! list of the sessions running in tmux ([`remember`], every half minute and
//! whenever it stops one), and when it starts ([`revive`]) after a reboot, or
//! finds its tmux session gone, it resumes each of them that isn't running,
//! in its folder, with Remote Control, as Resume would.
//!
//! The same goes for the Remote Control servers it started: each is started
//! again in its folder, which brings back the sessions it was serving. Those
//! sessions aren't resumed on their own.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::accounts;
use crate::rc_servers;
use crate::routes::{resume_held, ServerState};
use crate::sessions;

/// How often the list of running sessions is written down.
pub const REMEMBER_EVERY: Duration = Duration::from_secs(30);

const FILE: &str = "running.json";

#[derive(Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    /// The kernel's id for this boot, so a later start can tell it rebooted.
    boot_id: Option<String>,
    sessions: Vec<Remembered>,
    /// The Remote Control servers started from here.
    #[serde(default)]
    servers: Vec<RememberedServer>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RememberedServer {
    account: String,
    folder: String,
    name: Option<String>,
    spawn: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Remembered {
    account: String,
    id: String,
}

fn path(state: &ServerState) -> PathBuf {
    state.state_dir.join(FILE)
}

fn boot_id() -> Option<String> {
    fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .ok()
        .map(|id| id.trim().to_owned())
}

/// Write down the sessions running in tmux now, in every account.
pub fn remember(state: &ServerState) {
    let mut remembered = Vec::new();
    let mut servers = Vec::new();
    for account in accounts::discover(&state.config) {
        for server in rc_servers::list(&state.tmux, &account) {
            if server.window.is_some() {
                servers.push(RememberedServer {
                    account: account.name.clone(),
                    folder: server.folder,
                    name: server.name,
                    spawn: server.spawn,
                });
            }
        }
        for (id, entry) in sessions::running(&account, state.processes.as_ref()) {
            // A Remote Control server's sessions come back with it.
            if entry.tmux_location().is_some() && !rc_servers::is_served(&entry) {
                remembered.push(Remembered {
                    account: account.name.clone(),
                    id,
                });
            }
        }
    }
    remembered.sort_by(|a, b| (&a.account, &a.id).cmp(&(&b.account, &b.id)));
    servers.sort_by(|a, b| (&a.account, &a.folder).cmp(&(&b.account, &b.folder)));
    let snapshot = Snapshot {
        boot_id: boot_id(),
        sessions: remembered,
        servers,
    };
    let Ok(text) = serde_json::to_string_pretty(&snapshot) else {
        return;
    };
    let tmp = path(state).with_extension("json.tmp");
    if fs::write(&tmp, text).is_ok() {
        let _ = fs::rename(&tmp, path(state));
    }
}

/// Pure: whether what was running before should be brought back: the
/// machine has rebooted since it was written down, or tmux has lost the
/// server's session.
fn gone(previous_boot: Option<&str>, current_boot: Option<&str>, tmux_has_session: bool) -> bool {
    let rebooted =
        matches!((previous_boot, current_boot), (Some(before), Some(now)) if before != now);
    rebooted || !tmux_has_session
}

/// On start: resume what was running before a reboot, or before tmux went
/// away. Returns `(account, session, outcome)` for each one it tried.
pub fn revive(state: &ServerState) -> Vec<(String, String, Result<(), String>)> {
    let Some(snapshot) = fs::read_to_string(path(state))
        .ok()
        .and_then(|text| serde_json::from_str::<Snapshot>(&text).ok())
    else {
        return Vec::new();
    };
    if (snapshot.sessions.is_empty() && snapshot.servers.is_empty())
        || !gone(
            snapshot.boot_id.as_deref(),
            boot_id().as_deref(),
            state.tmux.has_session(),
        )
    {
        return Vec::new();
    }
    let mut outcomes = Vec::new();
    for server in snapshot.servers {
        let Some(account) = accounts::find(&state.config, &server.account) else {
            continue;
        };
        let outcome = revive_server(state, &account, &server);
        outcomes.push((
            server.account,
            format!("Remote Control server in {}", server.folder),
            outcome,
        ));
    }
    for remembered in snapshot.sessions {
        let Some(account) = accounts::find(&state.config, &remembered.account) else {
            continue;
        };
        if sessions::running(&account, state.processes.as_ref()).contains_key(&remembered.id) {
            continue;
        }
        let lock = state.account_lock(&account.name);
        let _held = lock
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let outcome = resume_held(state, &account, &remembered.id, true)
            .map(|_| ())
            .map_err(|err| err.message);
        outcomes.push((remembered.account, remembered.id, outcome));
    }
    outcomes
}

/// Start a remembered Remote Control server again, unless one runs in its
/// folder already.
fn revive_server(
    state: &ServerState,
    account: &accounts::AccountDir,
    server: &RememberedServer,
) -> Result<(), String> {
    let claude = crate::hostinfo::claude_path(&state.config)
        .ok_or_else(|| "Claude Code isn't installed.".to_owned())?;
    let folder = std::path::Path::new(&server.folder);
    let lock = state.account_lock(&account.name);
    let _held = lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    rc_servers::start(
        &state.tmux,
        &rc_servers::Start {
            account,
            claude: &claude,
            folder,
            name: server.name.clone(),
            spawn: server.spawn.clone(),
            window_name: crate::tmux::window_name(
                &format!("rc {}", server.name.as_deref().unwrap_or(&server.folder)),
                &format!("{}-rc", account.name),
            ),
            // It was trusted when it last ran.
            trust_folder: false,
        },
    )
    .map(|_| ())
    .map_err(|err| err.message)
}

/// Sessions a sign-out stopped, by account, to resume at the next sign-in.
const PENDING_FILE: &str = "pending-resume.json";

/// Serialises reading and rewriting [`PENDING_FILE`] across accounts.
static PENDING_LOCK: Mutex<()> = Mutex::new(());

fn pending_path(state: &ServerState) -> PathBuf {
    state.state_dir.join(PENDING_FILE)
}

fn read_pending(state: &ServerState) -> BTreeMap<String, Vec<String>> {
    fs::read_to_string(pending_path(state))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_pending(state: &ServerState, pending: &BTreeMap<String, Vec<String>>) {
    let Ok(text) = serde_json::to_string_pretty(pending) else {
        return;
    };
    let tmp = pending_path(state).with_extension("json.tmp");
    if fs::write(&tmp, text).is_ok() {
        let _ = fs::rename(&tmp, pending_path(state));
    }
}

fn update_pending(state: &ServerState, change: impl FnOnce(&mut BTreeMap<String, Vec<String>>)) {
    let _held = PENDING_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut pending = read_pending(state);
    change(&mut pending);
    pending.retain(|_, ids| !ids.is_empty());
    write_pending(state, &pending);
}

/// Remember `ids` of `account` to resume at its next sign-in, next to any it
/// already waits on.
pub fn hold_for_sign_in(state: &ServerState, account: &str, ids: &[String]) {
    update_pending(state, |pending| {
        let held = pending.entry(account.to_owned()).or_default();
        for id in ids {
            if !held.contains(id) {
                held.push(id.clone());
            }
        }
    });
}

/// The sessions of `account` waiting on its next sign-in.
pub fn pending(state: &ServerState, account: &str) -> Vec<String> {
    let _held = PENDING_LOCK
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    read_pending(state).remove(account).unwrap_or_default()
}

/// After a sign-in: resume each session of `account` that waits on it, as
/// Resume would, and let it go whether or not it came back, so a session
/// that can't resume doesn't wait forever. Returns `(session, outcome)`.
pub fn resume_pending(state: &ServerState, name: &str) -> Vec<(String, Result<(), String>)> {
    let mut outcomes = Vec::new();
    for id in pending(state, name) {
        let outcome = match accounts::find(&state.config, name) {
            None => Err("the profile is gone".to_owned()),
            Some(account) => {
                if sessions::running(&account, state.processes.as_ref()).contains_key(&id) {
                    Ok(())
                } else {
                    let lock = state.account_lock(&account.name);
                    let _held = lock
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    resume_held(state, &account, &id, true)
                        .map(|_| ())
                        .map_err(|err| err.message)
                }
            }
        };
        update_pending(state, |pending| {
            if let Some(held) = pending.get_mut(name) {
                held.retain(|held| held != &id);
            }
        });
        outcomes.push((id, outcome));
    }
    outcomes
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NothingRunning;

    impl crate::procs::ProcessTable for NothingRunning {
        fn is_live_claude(&self, _entry: &conductor_core::registry::RegistryEntry) -> bool {
            false
        }

        fn signal(&self, _entry: &conductor_core::registry::RegistryEntry, _force: bool) -> bool {
            false
        }
    }

    fn state_in(home: &std::path::Path) -> ServerState {
        let config = crate::config::Config::from_toml("", home).unwrap();
        let state_dir = home.join("state");
        fs::create_dir_all(&state_dir).unwrap();
        ServerState::new(config, &state_dir, std::sync::Arc::new(NothingRunning))
    }

    #[test]
    fn sessions_wait_for_the_next_sign_in_once_each_and_per_profile() {
        let home = tempfile::tempdir().unwrap();
        let state = state_in(home.path());
        assert!(pending(&state, "work").is_empty());

        hold_for_sign_in(&state, "work", &["a".into(), "b".into()]);
        hold_for_sign_in(&state, "work", &["b".into(), "c".into()]);
        hold_for_sign_in(&state, "home", &["z".into()]);
        assert_eq!(pending(&state, "work"), vec!["a", "b", "c"]);
        assert_eq!(pending(&state, "home"), vec!["z"]);

        // A profile that's gone can't resume them: they're let go, not kept
        // waiting for ever.
        let outcomes = resume_pending(&state, "work");
        assert_eq!(outcomes.len(), 3);
        assert!(outcomes.iter().all(|(_, outcome)| outcome.is_err()));
        assert!(pending(&state, "work").is_empty());
        assert_eq!(pending(&state, "home"), vec!["z"]);
    }

    #[test]
    fn brings_sessions_back_after_a_reboot_or_when_tmux_lost_them() {
        assert!(gone(Some("a"), Some("b"), true), "rebooted");
        assert!(gone(Some("a"), Some("a"), false), "tmux lost its session");
        assert!(
            !gone(Some("a"), Some("a"), true),
            "only the server restarted"
        );
        assert!(!gone(None, None, true), "no boot id to compare, tmux fine");
    }
}
