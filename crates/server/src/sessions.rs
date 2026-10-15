//! An account's sessions: its transcripts, joined with the registry of
//! running `claude` processes to say which are open, where in tmux, and
//! whether Remote Control is connected.

use std::collections::HashMap;
use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use conductor_core::api::{RemoteSession, TmuxWindow};
use conductor_core::registry::{read_registry, RegistryEntry};
use conductor_core::transcript::{
    read_transcript, read_transcript_from, short_line, title_file, transcripts, TranscriptInfo,
};

use crate::accounts::AccountDir;
use crate::procs::ProcessTable;

/// Parsed transcripts, keyed by path: listing reads every transcript, and
/// most don't change between two lists. One that did usually grew, as a
/// running session's does (to hundreds of megabytes), so only what was
/// appended is read. One that was replaced (moves write a new file and rename
/// it over), shrank or changed before the end of what was read is read again
/// in full.
#[derive(Default)]
pub struct TranscriptCache(Mutex<HashMap<PathBuf, Cached>>);

#[derive(Clone)]
struct Cached {
    inode: u64,
    modified: SystemTime,
    size: u64,
    /// Where the next read goes on from: the end of the last complete line.
    offset: u64,
    info: TranscriptInfo,
}

impl TranscriptCache {
    /// What the transcript at `path` says, reading only what changed.
    pub fn info(&self, path: &Path) -> Option<TranscriptInfo> {
        self.read(path)
            .map(|read| with_title_file(path, &read.info))
    }

    fn read(&self, path: &Path) -> Option<Cached> {
        let metadata = fs::metadata(path).ok()?;
        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let (inode, size) = (metadata.ino(), metadata.len());
        let gzipped = path.extension().is_some_and(|ext| ext == "gz");
        let known = self.0.lock().ok()?.remove(path);
        let (info, offset) = match known {
            Some(cached)
                if cached.inode == inode && cached.modified == modified && cached.size == size =>
            {
                (cached.info, cached.offset)
            }
            // Read on from where the last read stopped, unless the file
            // turns out to have changed before there.
            Some(cached) if !gzipped && cached.inode == inode && cached.offset <= size => {
                match read_transcript_from(path, cached.info, cached.offset) {
                    Ok(read) => read,
                    Err(_) => read_transcript_from(path, TranscriptInfo::default(), 0).ok()?,
                }
            }
            _ if gzipped => (read_transcript(path).ok()?, size),
            _ => read_transcript_from(path, TranscriptInfo::default(), 0).ok()?,
        };
        let cached = Cached {
            inode,
            modified,
            size,
            offset,
            info,
        };
        if let Ok(mut cache) = self.0.lock() {
            cache.insert(path.to_path_buf(), cached.clone());
        }
        Some(cached)
    }
}

/// `info` with its name taken from the file Claude Code keeps beside the
/// transcript at `path` when no record in it carries one. Read each time, as
/// that file changes on its own.
fn with_title_file(path: &Path, info: &TranscriptInfo) -> TranscriptInfo {
    let mut info = info.clone();
    if info.custom_title.is_none() {
        info.custom_title = title_file(path);
    }
    info
}

/// The live `claude` processes of an account, by session id: its registry
/// entries whose session Claude lists as live under that same pid (and whose
/// process is still there: Claude's answer is kept a moment, and a session
/// stopped since would still be in it), or, when Claude can't say, whose
/// process checks out on its own.
pub fn running(
    account: &AccountDir,
    processes: &dyn ProcessTable,
) -> HashMap<String, RegistryEntry> {
    let live = processes.live_sessions(account);
    read_registry(&account.dir)
        .into_iter()
        .filter(|(_, entry)| match &live {
            Some(live) => entry
                .session_id
                .as_ref()
                .and_then(|id| live.get(id))
                .is_some_and(|pid| *pid == entry.pid && processes.is_live_claude(entry)),
            None => processes.is_live_claude(entry),
        })
        .filter_map(|(_, entry)| Some((entry.session_id.clone()?, entry)))
        .collect()
}

/// How long a session is given to end once asked, before it is made to.
/// Short: a restart waits for this and for the new process together, within
/// the app's request timeout, and Claude ends at once on SIGTERM.
const STOP_GRACE: Duration = Duration::from_secs(4);
/// How long a process that was made to end is given to be gone.
const KILL_GRACE: Duration = Duration::from_secs(2);

/// End the running session `id` of `account`, the way closing its terminal
/// would: SIGTERM, then SIGKILL if it's still there after [`STOP_GRACE`].
/// Only the `claude` process is signalled, never the tmux pane around it,
/// which may be someone's shell. Returns the registry entry it had, or
/// `None` when it wasn't running.
pub fn stop(
    account: &AccountDir,
    id: &str,
    processes: &dyn ProcessTable,
) -> Result<Option<RegistryEntry>, String> {
    let Some(entry) = running(account, processes).remove(id) else {
        return Ok(None);
    };
    for (force, grace) in [(false, STOP_GRACE), (true, KILL_GRACE)] {
        processes.signal(&entry, force);
        let deadline = Instant::now() + grace;
        loop {
            if !processes.is_live_claude(&entry) {
                return Ok(Some(entry));
            }
            if Instant::now() >= deadline {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    Err(format!("Claude (process {}) didn't stop.", entry.pid))
}

/// The account's sessions, newest first. Sessions nothing happened in are
/// left out, unless they're running (a session just started is empty until
/// its first message).
pub fn list(
    account: &AccountDir,
    processes: &dyn ProcessTable,
    cache: &TranscriptCache,
) -> Vec<RemoteSession> {
    let running = running(account, processes);
    let mut sessions: Vec<(SystemTime, RemoteSession)> = Vec::new();
    let mut listed = std::collections::HashSet::new();
    for (_, id, path) in transcripts(&account.dir) {
        let Some(read) = cache.read(&path) else {
            continue;
        };
        let info = with_title_file(&path, &read.info);
        let live = running.get(&id);
        // A subagent's transcript isn't a session, and one nothing happened in
        // is left out as Claude's own /resume leaves it out.
        if (info.is_empty() || info.is_subagent_only()) && live.is_none() {
            continue;
        }
        listed.insert(id.clone());
        let used = last_used(&info, read.modified);
        sessions.push((used, summary(id, &info, live, used, read.size)));
    }
    // Claude writes a session's transcript with its first message; one
    // that's running but hasn't had one yet is listed from the registry.
    for (id, entry) in &running {
        if listed.contains(id) {
            continue;
        }
        let registered = fs::metadata(
            account
                .dir
                .join("sessions")
                .join(format!("{}.json", entry.pid)),
        )
        .and_then(|metadata| metadata.modified())
        .unwrap_or_else(|_| SystemTime::now());
        sessions.push((
            registered,
            summary(
                id.clone(),
                &TranscriptInfo::default(),
                Some(entry),
                registered,
                0,
            ),
        ));
    }
    sessions.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    sessions.into_iter().map(|(_, session)| session).collect()
}

/// When a session was last used: its transcript's last `timestamp`, or when
/// that is missing or doesn't parse, when the file was last written.
fn last_used(info: &TranscriptInfo, modified: SystemTime) -> SystemTime {
    info.last_timestamp
        .as_deref()
        .and_then(|timestamp| chrono::DateTime::parse_from_rfc3339(timestamp).ok())
        .map(SystemTime::from)
        .unwrap_or(modified)
}

fn summary(
    id: String,
    info: &TranscriptInfo,
    live: Option<&RegistryEntry>,
    modified: SystemTime,
    size: u64,
) -> RemoteSession {
    let user_named_live = live.filter(|entry| entry.named_by_user());
    RemoteSession {
        title: info
            .custom_title
            .clone()
            .or_else(|| user_named_live.and_then(|entry| entry.name.clone()))
            .or_else(|| info.ai_title.clone())
            // What Remote Control calls it (after its folder, unless named).
            .or_else(|| live.and_then(|entry| entry.name.clone()))
            .or_else(|| info.first_prompt.as_deref().and_then(short_line)),
        named: info.custom_title.is_some() || user_named_live.is_some(),
        cwd: live
            .and_then(|entry| entry.cwd.clone())
            .or_else(|| info.cwd.clone()),
        last_prompt: info.last_prompt.clone(),
        updated_at: chrono::DateTime::<chrono::Utc>::from(modified).to_rfc3339(),
        size_bytes: size,
        running: live.is_some(),
        window: live
            .and_then(|entry| entry.tmux_location())
            .map(|location| TmuxWindow {
                session: location.session,
                window_id: location.window_id,
                pane_id: location.pane_id,
            }),
        remote_control: live.is_some_and(|entry| entry.bridge_session_id.is_some()),
        remote_control_connecting: false,
        bridge_session_id: live.and_then(|entry| entry.bridge_session_id.clone()),
        waiting: false,
        empty: info.is_empty(),
        claude_version: live.and_then(|entry| entry.version.clone()),
        update_pending: false,
        installed_version: None,
        served: live.is_some_and(crate::rc_servers::is_served),
        id,
    }
}

/// Pure: whether version `installed` is newer than `running`, comparing
/// their dotted numbers (`2.1.281` > `2.1.280`, `2.10.0` > `2.9.9`). Either
/// one unreadable is not newer.
pub fn newer_version(installed: &str, running: &str) -> bool {
    fn numbers(version: &str) -> Option<Vec<u64>> {
        version
            .trim()
            .split(['.', '-', ' '])
            .take_while(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
            .map(|part| part.parse().ok())
            .collect::<Option<Vec<u64>>>()
            .filter(|parts| !parts.is_empty())
    }
    match (numbers(installed), numbers(running)) {
        (Some(installed), Some(running)) => installed > running,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_newer_installed_version_is_one_with_higher_numbers() {
        assert!(newer_version("2.1.281", "2.1.280"));
        assert!(newer_version("2.10.0", "2.9.9"));
        assert!(newer_version("2.1.281 (Claude Code)", "2.1.280"));
        assert!(!newer_version("2.1.280", "2.1.280"));
        assert!(!newer_version("2.1.279", "2.1.280"));
        assert!(!newer_version("", "2.1.280"));
        assert!(!newer_version("2.1.281", "unknown"));
    }
    use crate::procs::testing::FakeProcesses;
    use std::collections::HashSet;
    use std::path::Path;

    fn write(path: &Path, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    const NAMED: &str = "11111111-1111-1111-1111-111111111111";
    const OPEN: &str = "22222222-2222-2222-2222-222222222222";
    const EMPTY: &str = "33333333-3333-3333-3333-333333333333";

    fn account(root: &Path) -> AccountDir {
        let dir = root.join("work");
        let project = dir.join("projects/-home-m-code");
        write(
            &project.join(format!("{NAMED}.jsonl")),
            concat!(
                r#"{"type":"user","cwd":"/home/m/code"}"#,
                "\n",
                r#"{"type":"assistant"}"#,
                "\n",
                r#"{"type":"custom-title","customTitle":"Billing fix"}"#,
                "\n",
                r#"{"type":"last-prompt","lastPrompt":"ship it"}"#,
                "\n"
            ),
        );
        write(
            &project.join(format!("{OPEN}.jsonl")),
            concat!(
                r#"{"type":"user","cwd":"/home/m/code"}"#,
                "\n",
                r#"{"type":"assistant"}"#,
                "\n"
            ),
        );
        write(
            &project.join(format!("{EMPTY}.jsonl")),
            "{\"type\":\"user\"}\n",
        );
        write(
            &dir.join("sessions/4242.json"),
            &format!(
                r#"{{"pid":4242,"sessionId":"{OPEN}","cwd":"/home/m/other","tmux":"ai:@3.%5",
                    "name":"Deploy","nameSource":"user","bridgeSessionId":"b"}}"#
            ),
        );
        write(
            &dir.join("sessions/9999.json"),
            &format!(r#"{{"pid":9999,"sessionId":"{NAMED}"}}"#),
        );
        AccountDir {
            name: "work".into(),
            dir,
            is_default: false,
        }
    }

    #[test]
    fn a_subagents_transcript_is_no_session_and_a_title_file_names_one() {
        let root = tempfile::tempdir().unwrap();
        let account = account(root.path());
        let project = account.dir.join("projects/-home-m-code");
        write(
            &project.join("44444444-4444-4444-4444-444444444444.jsonl"),
            concat!(
                r#"{"type":"user","isSidechain":true,"timestamp":"2026-09-01T10:00:00Z","message":{"content":"task"}}"#,
                "\n",
                r#"{"type":"assistant","isSidechain":true,"timestamp":"2026-09-01T10:00:01Z"}"#,
                "\n",
            ),
        );
        let untitled = "55555555-5555-5555-5555-555555555555";
        write(
            &project.join(format!("{untitled}.jsonl")),
            concat!(
                r#"{"type":"user","isSidechain":false,"timestamp":"2026-09-01T10:00:00Z","message":{"content":"Look into the flaky build"}}"#,
                "\n",
                r#"{"type":"assistant","isSidechain":false,"timestamp":"2026-09-01T10:00:01Z"}"#,
                "\n",
            ),
        );
        let processes = FakeProcesses(HashSet::new());
        let cache = TranscriptCache::default();

        let sessions = list(&account, &processes, &cache);
        assert!(!sessions.iter().any(|s| s.id.starts_with("4444")));
        let untitled_session = sessions.iter().find(|s| s.id == untitled).unwrap();
        assert_eq!(
            untitled_session.title.as_deref(),
            Some("Look into the flaky build")
        );
        assert_eq!(untitled_session.updated_at, "2026-09-01T10:00:01+00:00");

        write(
            &project.join(untitled).join("custom-title.json"),
            r#"{"customTitle":"Flaky build"}"#,
        );
        let sessions = list(&account, &processes, &cache);
        let named = sessions.iter().find(|s| s.id == untitled).unwrap();
        assert_eq!(named.title.as_deref(), Some("Flaky build"));
        assert!(named.named);
    }

    #[test]
    fn joins_transcripts_with_the_live_registry() {
        let root = tempfile::tempdir().unwrap();
        let account = account(root.path());
        // 9999's file is stale: that process is gone.
        let processes = FakeProcesses(HashSet::from([4242]));
        let sessions = list(&account, &processes, &TranscriptCache::default());

        assert_eq!(sessions.len(), 2, "the empty session is hidden");
        let named = sessions.iter().find(|s| s.id == NAMED).unwrap();
        assert_eq!(named.title.as_deref(), Some("Billing fix"));
        assert!(named.named);
        assert!(!named.running);
        assert_eq!(named.window, None);
        assert_eq!(named.last_prompt.as_deref(), Some("ship it"));

        let open = sessions.iter().find(|s| s.id == OPEN).unwrap();
        assert!(open.running);
        assert!(open.named, "named in the app, so Remote Control uses it");
        assert_eq!(open.title.as_deref(), Some("Deploy"));
        assert_eq!(open.cwd.as_deref(), Some("/home/m/other"));
        assert!(open.remote_control);
        assert_eq!(
            open.window,
            Some(TmuxWindow {
                session: "ai".into(),
                window_id: "@3".into(),
                pane_id: "%5".into()
            })
        );
    }

    #[test]
    fn lists_a_running_session_before_its_first_message() {
        let root = tempfile::tempdir().unwrap();
        let account = account(root.path());
        const FRESH: &str = "44444444-4444-4444-4444-444444444444";
        write(
            &account.dir.join("sessions/5151.json"),
            &format!(
                r#"{{"pid":5151,"sessionId":"{FRESH}","cwd":"/home/m/david","name":"david","nameSource":"derived","tmux":"ai:@10.%12"}}"#
            ),
        );
        // Registered after every transcript was last written.
        fs::File::options()
            .write(true)
            .open(account.dir.join("sessions/5151.json"))
            .unwrap()
            .set_modified(SystemTime::now() + std::time::Duration::from_secs(5))
            .unwrap();
        let processes = FakeProcesses(HashSet::from([5151]));
        let sessions = list(&account, &processes, &TranscriptCache::default());
        let fresh = sessions.iter().find(|s| s.id == FRESH).expect("listed");
        assert!(fresh.running);
        assert!(fresh.empty, "gone once stopped, so the app can say so");
        assert!(
            sessions.iter().filter(|s| s.id != FRESH).all(|s| !s.empty),
            "the rest have something to resume"
        );
        assert_eq!(
            fresh.title.as_deref(),
            Some("david"),
            "what Remote Control calls it"
        );
        assert!(!fresh.named);
        assert_eq!(fresh.cwd.as_deref(), Some("/home/m/david"));
        assert_eq!(
            fresh.window.as_ref().map(|w| w.window_id.as_str()),
            Some("@10")
        );
        assert_eq!(sessions[0].id, FRESH, "newest first");
    }

    #[test]
    fn the_cache_notices_a_transcript_that_changed() {
        let root = tempfile::tempdir().unwrap();
        let account = account(root.path());
        let processes = FakeProcesses(HashSet::new());
        let cache = TranscriptCache::default();
        assert_eq!(list(&account, &processes, &cache).len(), 2);
        write(
            &account
                .dir
                .join(format!("projects/-home-m-code/{EMPTY}.jsonl")),
            "{\"type\":\"user\"}\n{\"type\":\"assistant\"}\n",
        );
        assert_eq!(list(&account, &processes, &cache).len(), 3);
    }

    #[test]
    fn the_cache_reads_on_in_a_growing_transcript_and_again_in_a_replaced_one() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        write(&path, "{\"type\":\"user\",\"cwd\":\"/a\"}\n");
        let cache = TranscriptCache::default();
        assert_eq!(cache.info(&path).unwrap().cwd.as_deref(), Some("/a"));

        // Claude appends.
        let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"type\":\"custom-title\",\"customTitle\":\"Named\"}\n")
            .unwrap();
        let info = cache.info(&path).unwrap();
        assert_eq!(info.cwd.as_deref(), Some("/a"));
        assert_eq!(info.title().as_deref(), Some("Named"));

        // A move writes a new file and renames it over: nothing of the old
        // one is kept, though the new one is longer.
        let part = dir.path().join("s.jsonl.part");
        write(
            &part,
            "{\"type\":\"user\",\"cwd\":\"/moved/somewhere/else/entirely\"}\n{\"type\":\"assistant\"}\n",
        );
        fs::rename(&part, &path).unwrap();
        let info = cache.info(&path).unwrap();
        assert_eq!(info.cwd.as_deref(), Some("/moved/somewhere/else/entirely"));
        assert_eq!(info.title(), None);
    }

    /// Claude listing an account's live sessions itself.
    struct ClaudeSays(HashMap<String, i32>);

    impl ProcessTable for ClaudeSays {
        fn is_live_claude(&self, entry: &RegistryEntry) -> bool {
            // Only asked of what Claude lists: 102 has ended since.
            entry.pid != 102
        }

        fn signal(&self, _entry: &RegistryEntry, _force: bool) -> bool {
            false
        }

        fn live_sessions(&self, _account: &AccountDir) -> Option<HashMap<String, i32>> {
            Some(self.0.clone())
        }
    }

    #[test]
    fn claude_says_which_registered_sessions_are_running() {
        let dir = tempfile::tempdir().unwrap();
        let account = AccountDir {
            name: "work".into(),
            dir: dir.path().to_path_buf(),
            is_default: false,
        };
        for (pid, id) in [(101, NAMED), (102, OPEN), (103, EMPTY), (104, NAMED)] {
            write(
                &dir.path().join(format!("sessions/{pid}.json")),
                &format!(r#"{{"pid":{pid},"sessionId":"{id}"}}"#),
            );
        }
        // EMPTY isn't listed. OPEN is listed under its pid, but was stopped
        // after Claude said so: its process is gone.
        let claude = ClaudeSays(HashMap::from([
            (NAMED.to_owned(), 101),
            (OPEN.to_owned(), 102),
        ]));
        let running = running(&account, &claude);
        assert_eq!(running.len(), 1);
        assert_eq!(running.get(NAMED).map(|entry| entry.pid), Some(101));
    }
}
