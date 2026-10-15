//! What the process table says about the processes this user can see: each
//! one's parent and command line, and one's environment and folder.
//!
//! On Linux it's read from `/proc`. On macOS it's the kernel's own calls
//! (`proc_listallpids`, `proc_pidinfo` and the `KERN_PROCARGS2` sysctl),
//! because `ps` joins a command line's arguments with spaces and can't give
//! them back exactly. Elsewhere nothing is known.

use std::path::PathBuf;

/// A process, as much as finding Remote Control servers needs.
pub struct Process {
    pub pid: i32,
    pub ppid: i32,
    pub argv: Vec<String>,
}

/// Every process this user can see, with its command line. One whose command
/// line can't be read (another user's) is left out.
pub fn all() -> Vec<Process> {
    system::pids()
        .into_iter()
        .filter_map(|pid| {
            Some(Process {
                pid,
                ppid: system::parent(pid)?,
                argv: argv(pid)?,
            })
        })
        .collect()
}

/// Process `pid`'s command line.
pub fn argv(pid: i32) -> Option<Vec<String>> {
    system::argv_and_environment(pid).map(|(argv, _)| argv)
}

/// Process `pid`'s environment variable `name`.
pub fn environment_var(pid: i32, name: &str) -> Option<String> {
    let (_, environment) = system::argv_and_environment(pid)?;
    let prefix = format!("{name}=");
    environment
        .iter()
        .find_map(|pair| pair.strip_prefix(&prefix).map(str::to_owned))
}

/// Process `pid`'s working folder.
pub fn working_dir(pid: i32) -> Option<PathBuf> {
    system::working_dir(pid)
}

fn lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
/// Pure: NUL-separated strings, as `/proc/<pid>/cmdline` and `environ` hold
/// them, without the empty one after the last NUL.
fn nul_separated(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(lossy)
        .collect()
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
/// Pure: the parent pid in `/proc/<pid>/stat`, after the command name (which
/// may hold spaces and parentheses, so it's read from the last `)`).
fn parent_pid(stat: &str) -> Option<i32> {
    stat[stat.rfind(')')? + 1..]
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
/// Pure: the command line and environment in what macOS's `KERN_PROCARGS2`
/// returns: the argument count (a native-endian `int`), the executable's
/// path, NULs up to the next string, then the arguments and the environment,
/// each NUL-terminated. The environment ends at the first empty string.
fn read_procargs(buffer: &[u8]) -> Option<(Vec<String>, Vec<String>)> {
    let argc = usize::try_from(i32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?)).ok()?;
    let rest = &buffer[4..];
    let path_end = rest.iter().position(|byte| *byte == 0)?;
    let strings_start = path_end + rest[path_end..].iter().position(|byte| *byte != 0)?;
    let mut strings = rest[strings_start..].split(|byte| *byte == 0);
    let argv: Vec<String> = strings.by_ref().take(argc).map(lossy).collect();
    if argv.len() != argc {
        return None;
    }
    let environment = strings
        .take_while(|pair| !pair.is_empty())
        .map(lossy)
        .collect();
    Some((argv, environment))
}

#[cfg(target_os = "linux")]
mod system {
    use std::fs;
    use std::path::PathBuf;

    pub fn pids() -> Vec<i32> {
        let Ok(entries) = fs::read_dir("/proc") else {
            return Vec::new();
        };
        entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_str()?.parse().ok())
            .collect()
    }

    pub fn parent(pid: i32) -> Option<i32> {
        super::parent_pid(&fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
    }

    pub fn argv_and_environment(pid: i32) -> Option<(Vec<String>, Vec<String>)> {
        let argv = super::nul_separated(&fs::read(format!("/proc/{pid}/cmdline")).ok()?);
        let environment = fs::read(format!("/proc/{pid}/environ"))
            .map(|environ| super::nul_separated(&environ))
            .unwrap_or_default();
        Some((argv, environment))
    }

    pub fn working_dir(pid: i32) -> Option<PathBuf> {
        fs::read_link(format!("/proc/{pid}/cwd")).ok()
    }
}

#[cfg(target_os = "macos")]
mod system {
    use std::ffi::{c_int, c_void, CStr};
    use std::mem;
    use std::path::PathBuf;
    use std::ptr;

    pub fn pids() -> Vec<i32> {
        // SAFETY: a null buffer asks only for the count.
        let count = unsafe { libc::proc_listallpids(ptr::null_mut(), 0) };
        let Ok(count) = usize::try_from(count) else {
            return Vec::new();
        };
        // Room for processes started since.
        let mut pids = vec![0 as c_int; count + 64];
        let Ok(bytes) = c_int::try_from(pids.len() * mem::size_of::<c_int>()) else {
            return Vec::new();
        };
        // SAFETY: the buffer is `bytes` long, and the call writes no more.
        let found = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast::<c_void>(), bytes) };
        let Ok(found) = usize::try_from(found) else {
            return Vec::new();
        };
        pids.truncate(found.min(pids.len()));
        pids.retain(|pid| *pid > 0);
        pids
    }

    /// `proc_pidinfo` of `flavor` into a zeroed `T`, if it filled all of it.
    fn pid_info<T>(pid: i32, flavor: c_int) -> Option<T> {
        let size = c_int::try_from(mem::size_of::<T>()).ok()?;
        // SAFETY: `T` is one of libc's plain C structs, for which all zeroes
        // is a valid value.
        let mut info: T = unsafe { mem::zeroed() };
        // SAFETY: the buffer is `size` bytes of `info`, and the call writes no more.
        let written = unsafe {
            libc::proc_pidinfo(
                pid,
                flavor,
                0,
                ptr::from_mut(&mut info).cast::<c_void>(),
                size,
            )
        };
        (written == size).then_some(info)
    }

    pub fn parent(pid: i32) -> Option<i32> {
        let info: libc::proc_bsdinfo = pid_info(pid, libc::PROC_PIDTBSDINFO)?;
        i32::try_from(info.pbi_ppid).ok()
    }

    pub fn argv_and_environment(pid: i32) -> Option<(Vec<String>, Vec<String>)> {
        let mut argmax: c_int = 0;
        let mut size = mem::size_of::<c_int>();
        let mut name = [libc::CTL_KERN, libc::KERN_ARGMAX];
        // SAFETY: `name` holds 2 entries and `argmax` is `size` bytes.
        let read = unsafe {
            libc::sysctl(
                name.as_mut_ptr(),
                2,
                ptr::from_mut(&mut argmax).cast::<c_void>(),
                &mut size,
                ptr::null_mut(),
                0,
            )
        };
        if read != 0 {
            return None;
        }
        let mut buffer = vec![0u8; usize::try_from(argmax).ok()?];
        let mut size = buffer.len();
        let mut name = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        // SAFETY: `name` holds 3 entries and the buffer is `size` bytes.
        let read = unsafe {
            libc::sysctl(
                name.as_mut_ptr(),
                3,
                buffer.as_mut_ptr().cast::<c_void>(),
                &mut size,
                ptr::null_mut(),
                0,
            )
        };
        if read != 0 {
            return None;
        }
        buffer.truncate(size);
        super::read_procargs(&buffer)
    }

    pub fn working_dir(pid: i32) -> Option<PathBuf> {
        let info: libc::proc_vnodepathinfo = pid_info(pid, libc::PROC_PIDVNODEPATHINFO)?;
        let path: Vec<u8> = info
            .pvi_cdir
            .vip_path
            .iter()
            .flatten()
            .map(|byte| *byte as u8)
            .collect();
        let path = CStr::from_bytes_until_nul(&path).ok()?.to_str().ok()?;
        (!path.is_empty()).then(|| PathBuf::from(path))
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod system {
    use std::path::PathBuf;

    pub fn pids() -> Vec<i32> {
        Vec::new()
    }

    pub fn parent(_pid: i32) -> Option<i32> {
        None
    }

    pub fn argv_and_environment(_pid: i32) -> Option<(Vec<String>, Vec<String>)> {
        None
    }

    pub fn working_dir(_pid: i32) -> Option<PathBuf> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_parent_after_a_name_with_parentheses() {
        assert_eq!(
            parent_pid("1584921 (claude (x) y) S 1584606 1584921 1"),
            Some(1584606)
        );
        assert_eq!(parent_pid("12 (bash) R 1 12 12"), Some(1));
        assert_eq!(parent_pid("no parentheses"), None);
    }

    #[test]
    fn splits_a_nul_separated_command_line() {
        assert_eq!(
            nul_separated(b"claude\0remote-control\0--name\0vb4 (xJOPA)\0"),
            ["claude", "remote-control", "--name", "vb4 (xJOPA)"]
        );
    }

    fn procargs(argc: i32, rest: &[u8]) -> Vec<u8> {
        let mut buffer = argc.to_ne_bytes().to_vec();
        buffer.extend_from_slice(rest);
        buffer
    }

    #[test]
    fn reads_macos_procargs_with_spaces_in_arguments() {
        let buffer = procargs(
            4,
            b"/Users/me/.local/bin/claude\0\0\0\0claude\0remote-control\0--name\0vb4 (xJOPA)\0\
              CLAUDE_CONFIG_DIR=/Users/me/.claude-accounts/Misc\0PATH=/usr/bin\0\0\0junk\0",
        );
        let (argv, environment) = read_procargs(&buffer).unwrap();
        assert_eq!(argv, ["claude", "remote-control", "--name", "vb4 (xJOPA)"]);
        assert_eq!(
            environment,
            [
                "CLAUDE_CONFIG_DIR=/Users/me/.claude-accounts/Misc",
                "PATH=/usr/bin"
            ]
        );
    }

    #[test]
    fn refuses_procargs_that_end_too_soon() {
        assert!(read_procargs(&procargs(3, b"/bin/claude\0\0claude\0")).is_none());
        assert!(read_procargs(b"\x01\0").is_none());
        assert!(read_procargs(&procargs(1, b"/bin/claude")).is_none());
    }

    #[test]
    fn sees_this_process() {
        if cfg!(any(target_os = "linux", target_os = "macos")) {
            let me = i32::try_from(std::process::id()).unwrap();
            assert!(!argv(me).unwrap().is_empty());
            assert_eq!(
                working_dir(me).unwrap().canonicalize().unwrap(),
                std::env::current_dir().unwrap().canonicalize().unwrap()
            );
            assert!(environment_var(me, "PATH").is_some());
            assert!(all().iter().any(|process| process.pid == me));
        }
    }
}
