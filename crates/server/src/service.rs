//! `install-service`: run the server as the user, at every login: under
//! systemd on Linux, as a launchd agent on macOS.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub const UNIT_NAME: &str = "remote-control-conductor-server.service";

/// The service's name before the app was renamed (from ai-profiles-remote).
pub const LEGACY_UNIT_NAME: &str = "ai-profiles-server.service";

/// The unit file. `PATH` is the one `install-service` ran with, because a
/// user service otherwise gets systemd's bare PATH, which lacks the places
/// `claude` and `tmux` are usually installed.
///
/// `KillMode=process` stops only the server on restart: a tmux server it
/// started (and every Claude session in it) is a child in its cgroup, and
/// would otherwise be killed too. No `PrivateTmp`, because tmux keeps its
/// socket in /tmp and the server has to reach the user's.
pub fn unit_text(executable: &Path, path_env: &str) -> String {
    format!(
        "[Unit]\n\
         Description=Remote Control CLI Servers server: Claude sessions on this machine, for your Mac\n\
         After=network-online.target\n\
         \n\
         [Service]\n\
         ExecStart={} serve\n\
         Environment=PATH={path_env}\n\
         Restart=on-failure\n\
         RestartSec=3\n\
         KillMode=process\n\
         NoNewPrivileges=yes\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        executable.display()
    )
}

pub fn unit_path(home: &Path) -> PathBuf {
    home.join(".config/systemd/user").join(UNIT_NAME)
}

/// The launchd agent's label, and its file's name.
pub const AGENT_LABEL: &str = "com.marcusadolfsson.remote-control-conductor-server";

/// The launchd agent. As with the unit, `PATH` is the one `install-service`
/// ran with: an agent otherwise gets launchd's bare PATH, without Homebrew's
/// `tmux` or `~/.local/bin/claude`. `AbandonProcessGroup` is `KillMode=process`'s
/// counterpart: stopping the server leaves tmux and its sessions running.
pub fn agent_text(executable: &Path, path_env: &str, log: &Path) -> String {
    let escape = |text: &str| {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
    };
    let executable = escape(&executable.display().to_string());
    let path_env = escape(path_env);
    let log = escape(&log.display().to_string());
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \t<key>Label</key><string>{AGENT_LABEL}</string>\n\
         \t<key>ProgramArguments</key>\n\
         \t<array><string>{executable}</string><string>serve</string></array>\n\
         \t<key>EnvironmentVariables</key>\n\
         \t<dict><key>PATH</key><string>{path_env}</string></dict>\n\
         \t<key>RunAtLoad</key><true/>\n\
         \t<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n\
         \t<key>ThrottleInterval</key><integer>3</integer>\n\
         \t<key>AbandonProcessGroup</key><true/>\n\
         \t<key>StandardOutPath</key><string>{log}</string>\n\
         \t<key>StandardErrorPath</key><string>{log}</string>\n\
         </dict>\n\
         </plist>\n"
    )
}

pub fn agent_path(home: &Path) -> PathBuf {
    home.join("Library/LaunchAgents")
        .join(format!("{AGENT_LABEL}.plist"))
}

pub fn agent_log(home: &Path) -> PathBuf {
    home.join("Library/Logs/remote-control-conductor-server.log")
}

/// Where to watch the running service's output.
pub fn logs_hint(home: &Path) -> String {
    if cfg!(target_os = "macos") {
        format!("tail -f {}", agent_log(home).display())
    } else {
        format!("journalctl --user -u {UNIT_NAME} -f")
    }
}

/// Where the service is defined: the launchd agent on macOS, the unit elsewhere.
pub fn installed_path(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        agent_path(home)
    } else {
        unit_path(home)
    }
}

/// Whether the service is running now.
pub fn running() -> bool {
    if cfg!(target_os = "macos") {
        let Ok(uid) = user_id() else {
            return false;
        };
        Command::new("/bin/launchctl")
            .args(["print", &format!("gui/{uid}/{AGENT_LABEL}")])
            .output()
            .is_ok_and(|output| {
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout).contains("state = running")
            })
    } else {
        Command::new("systemctl")
            .args(["--user", "is-active", "--quiet", UNIT_NAME])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }
}

fn path_env() -> String {
    std::env::var("PATH").unwrap_or_else(|_| "/usr/local/bin:/usr/bin:/bin".into())
}

/// Write the agent and (unless told not to) load it, which starts it now and
/// at every login. Loading it again restarts it, picking up a rebuilt binary.
#[cfg(target_os = "macos")]
pub fn install(home: &Path, start: bool) -> io::Result<PathBuf> {
    let executable = std::env::current_exe()?.canonicalize()?;
    let agent = agent_path(home);
    let log = agent_log(home);
    fs::create_dir_all(agent.parent().expect("an agent path has a folder"))?;
    fs::create_dir_all(log.parent().expect("a log path has a folder"))?;
    fs::write(&agent, agent_text(&executable, &path_env(), &log))?;
    if start {
        let domain = format!("gui/{}", user_id()?);
        // Not loaded yet is fine: there's nothing to restart.
        let service = format!("{domain}/{AGENT_LABEL}");
        let _ = Command::new("/bin/launchctl")
            .args(["bootout", &service])
            .stderr(Stdio::null())
            .status();
        // `bootout` returns before the old one is gone, and loading it again
        // meanwhile fails (I/O error, 5): wait for it, then retry once more.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut status = None;
        while std::time::Instant::now() < deadline {
            let loaded = Command::new("/bin/launchctl")
                .args(["print", &service])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success());
            if !loaded {
                let tried = Command::new("/bin/launchctl")
                    .args(["bootstrap", &domain])
                    .arg(&agent)
                    .stderr(Stdio::null())
                    .status()?;
                if tried.success() {
                    status = Some(tried);
                    break;
                }
                status = Some(tried);
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        let status = status.unwrap_or_default();
        if !status.success() {
            return Err(io::Error::other(format!(
                "launchctl bootstrap {domain} {} failed ({status})",
                agent.display()
            )));
        }
    }
    Ok(agent)
}

fn user_id() -> io::Result<String> {
    let output = Command::new("/usr/bin/id").arg("-u").output()?;
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

/// Write the unit, reload systemd, and (unless told not to) start it now and
/// at every login.
#[cfg(not(target_os = "macos"))]
pub fn install(home: &Path, start: bool) -> io::Result<PathBuf> {
    let executable = std::env::current_exe()?.canonicalize()?;
    let path_env = path_env();
    let unit = unit_path(home);
    fs::create_dir_all(unit.parent().expect("a unit path has a folder"))?;
    fs::write(&unit, unit_text(&executable, &path_env))?;
    systemctl(&["daemon-reload"])?;
    if start {
        systemctl(&["enable", "--now", UNIT_NAME])?;
        // Picks up a rebuilt binary when the service was already running.
        systemctl(&["restart", UNIT_NAME])?;
    }
    Ok(unit)
}

fn systemctl(args: &[&str]) -> io::Result<()> {
    let status = Command::new("systemctl")
        .arg("--user")
        .args(args)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "systemctl --user {} failed ({status})",
            args.join(" ")
        )))
    }
}

/// Whether the service under its old name is running: this server's
/// previous binary, which still uses the folders under their old names.
pub fn legacy_active() -> bool {
    if cfg!(target_os = "macos") {
        return false;
    }
    Command::new("systemctl")
        .args(["--user", "--quiet", "is-active", LEGACY_UNIT_NAME])
        // Quiet where there's no systemd, as in a container.
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

/// Stop and remove the service under its old name, if there is one. Its
/// sessions keep running: the unit had `KillMode=process`, so only the old
/// server stops, not the tmux server it started. `Ok(true)` when there was one.
pub fn retire_legacy(home: &Path) -> io::Result<bool> {
    if cfg!(target_os = "macos") {
        return Ok(false);
    }
    let unit = home.join(".config/systemd/user").join(LEGACY_UNIT_NAME);
    if !unit.exists() {
        return Ok(false);
    }
    // Already stopped or never enabled: nothing to undo, and the file goes anyway.
    let _ = systemctl(&["disable", "--now", LEGACY_UNIT_NAME]);
    fs::remove_file(&unit)?;
    systemctl(&["daemon-reload"])?;
    Ok(true)
}

/// Whether the user's services keep running after they log out.
pub fn lingering() -> Option<bool> {
    if cfg!(target_os = "macos") {
        return None;
    }
    let user = std::env::var("USER").ok()?;
    let output = Command::new("loginctl")
        .args(["show-user", &user, "-p", "Linger", "--value"])
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&output.stdout).trim() == "yes")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_unit_keeps_sessions_alive_across_restarts() {
        let text = unit_text(
            Path::new("/home/m/bin/remote-control-conductor-server"),
            "/home/m/.local/bin:/usr/bin",
        );
        assert!(text.contains("ExecStart=/home/m/bin/remote-control-conductor-server serve\n"));
        assert!(text.contains("Environment=PATH=/home/m/.local/bin:/usr/bin\n"));
        assert!(text.contains("KillMode=process\n"));
        assert!(!text.contains("PrivateTmp"));
        assert!(text.contains("WantedBy=default.target"));
    }

    #[test]
    fn the_agent_keeps_sessions_alive_across_restarts() {
        let text = agent_text(
            Path::new("/Users/m/.local/bin/remote-control-conductor-server"),
            "/opt/homebrew/bin:/usr/bin",
            Path::new("/Users/m/Library/Logs/remote-control-conductor-server.log"),
        );
        assert!(text.contains(
            "<array><string>/Users/m/.local/bin/remote-control-conductor-server</string><string>serve</string></array>"
        ));
        assert!(text.contains("<key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string>"));
        assert!(text.contains("<key>AbandonProcessGroup</key><true/>"));
        assert!(text.contains("<key>RunAtLoad</key><true/>"));
        assert!(text.contains(&format!("<string>{AGENT_LABEL}</string>")));
    }

    #[test]
    fn the_agent_escapes_what_xml_would_misread() {
        let text = agent_text(Path::new("/a&b/server"), "/x<y", Path::new("/l"));
        assert!(text.contains("/a&amp;b/server"));
        assert!(text.contains("/x&lt;y"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_agent_is_a_property_list_launchd_reads() {
        let dir = tempfile::tempdir().unwrap();
        let agent = dir.path().join("agent.plist");
        fs::write(
            &agent,
            agent_text(
                Path::new("/a&b/server"),
                "/opt/homebrew/bin",
                Path::new("/l"),
            ),
        )
        .unwrap();
        let lint = Command::new("/usr/bin/plutil")
            .arg("-lint")
            .arg(&agent)
            .output()
            .unwrap();
        assert!(lint.status.success(), "{lint:?}");
    }
}
