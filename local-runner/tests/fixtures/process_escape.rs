use std::env;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};
use std::thread;
use std::time::Duration;

unsafe extern "C" {
    fn fcntl(fd: i32, command: i32, ...) -> i32;
    fn getpgid(pid: i32) -> i32;
    fn setsid() -> i32;
    fn setpgid(pid: i32, pgid: i32) -> i32;
}

const F_GETFD: i32 = 1;

fn main() -> ExitCode {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    match arguments.first().map(String::as_str) {
        Some("probe-escape") if arguments.len() == 2 => probe_escape(&arguments[1]),
        Some("escape-then-write") if arguments.len() == 3 => {
            escape_then_write(&arguments[1], Path::new(&arguments[2]))
        }
        Some("probe-spawn-pgroup") if arguments.len() == 1 => probe_spawn_process_group(),
        Some("spawn-escape-then-write") if arguments.len() == 2 => {
            spawn_escape_then_write(Path::new(&arguments[1]))
        }
        Some("delayed-write") if arguments.len() == 2 => delayed_write(Path::new(&arguments[1])),
        Some("probe-inherited-fds") if arguments.len() == 3 => {
            probe_inherited_fds(&arguments[1], &arguments[2])
        }
        _ => {
            eprintln!("invalid fixture arguments");
            ExitCode::from(64)
        }
    }
}

fn attempt_escape(mode: &str) -> Result<(), std::io::Error> {
    let result = match mode {
        "setsid" => unsafe { setsid() },
        "setpgid" => unsafe { setpgid(0, 0) },
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "unknown escape mode",
            ))
        }
    };
    if result == -1 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

fn probe_escape(mode: &str) -> ExitCode {
    match attempt_escape(mode) {
        Ok(()) => {
            println!("escape-allowed:{mode}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("escape-denied:{mode}:{error}");
            ExitCode::SUCCESS
        }
    }
}

fn escape_then_write(mode: &str, marker: &Path) -> ExitCode {
    let _ = attempt_escape(mode);
    thread::sleep(Duration::from_millis(900));
    match fs::write(marker, format!("survived:{mode}")) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("marker write failed: {error}");
            ExitCode::from(74)
        }
    }
}

fn probe_spawn_process_group() -> ExitCode {
    let mut child = match Command::new("/bin/sleep")
        .arg("1")
        .process_group(0)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            println!("spawn-pgroup-denied:{error}");
            return ExitCode::SUCCESS;
        }
    };
    let pid = child.id() as i32;
    let process_group = unsafe { getpgid(pid) };
    if process_group == pid {
        println!("spawn-pgroup-allowed");
    } else {
        println!("spawn-pgroup-denied:pid={pid}:pgid={process_group}");
    }
    let _ = child.kill();
    let _ = child.wait();
    ExitCode::SUCCESS
}

fn spawn_escape_then_write(marker: &Path) -> ExitCode {
    let executable = match env::current_exe() {
        Ok(path) => path,
        Err(error) => {
            eprintln!("could not resolve fixture executable: {error}");
            return ExitCode::from(74);
        }
    };
    match Command::new(executable)
        .arg("delayed-write")
        .arg(marker)
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(_) => {
            println!("spawn-escape-allowed");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("spawn-escape-denied:{error}");
            ExitCode::SUCCESS
        }
    }
}

fn delayed_write(marker: &Path) -> ExitCode {
    thread::sleep(Duration::from_millis(900));
    match fs::write(marker, "spawned process-group survived") {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("spawned marker write failed: {error}");
            ExitCode::from(74)
        }
    }
}

fn probe_inherited_fds(file_fd: &str, socket_fd: &str) -> ExitCode {
    let file_fd = match file_fd.parse::<i32>() {
        Ok(fd) => fd,
        Err(error) => {
            eprintln!("invalid file fd: {error}");
            return ExitCode::from(64);
        }
    };
    let socket_fd = match socket_fd.parse::<i32>() {
        Ok(fd) => fd,
        Err(error) => {
            eprintln!("invalid socket fd: {error}");
            return ExitCode::from(64);
        }
    };

    if descriptor_is_open(file_fd) {
        println!("inherited-file-descriptor-open");
        let mut file = unsafe { File::from_raw_fd(file_fd) };
        let mut content = String::new();
        match file.read_to_string(&mut content) {
            Ok(_) => println!("inherited-file-content:{content}"),
            Err(error) => println!("inherited-file-read-denied:{error}"),
        }
    } else {
        println!("inherited-file-descriptor-closed");
    }

    if descriptor_is_open(socket_fd) {
        println!("inherited-socket-descriptor-open");
        let mut socket = unsafe { File::from_raw_fd(socket_fd) };
        match socket.write_all(b"inherited-socket-open") {
            Ok(()) => println!("inherited-socket-write-succeeded"),
            Err(error) => println!("inherited-socket-write-denied:{error}"),
        }
    } else {
        println!("inherited-socket-descriptor-closed");
    }
    ExitCode::SUCCESS
}

fn descriptor_is_open(fd: i32) -> bool {
    (unsafe { fcntl(fd, F_GETFD) }) != -1
}
