//! Standalone experiment. Nothing in this module is a product sandbox contract.
use super::{quote_arg, Options};
#[path = "restricted.rs"]
mod restricted;
use restricted::Identity;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    ffi::c_void,
    fs::{self, File},
    io::Read,
    mem::{size_of, zeroed},
    os::windows::{ffi::OsStrExt, fs::MetadataExt, io::AsRawHandle},
    path::{Component, Path, PathBuf},
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Security::{Authorization::*, *},
    Storage::FileSystem::*,
    System::{JobObjects::*, SystemInformation::*, Threading::*},
};

type Result<T> = std::result::Result<T, String>;
fn win_error(label: &str) -> String {
    format!("{label}: {}", std::io::Error::last_os_error())
}
fn io<T>(v: std::io::Result<T>) -> Result<T> {
    v.map_err(|e| e.to_string())
}
fn wide(s: impl AsRef<std::ffi::OsStr>) -> Vec<u16> {
    s.as_ref().encode_wide().chain(Some(0)).collect()
}
struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
// Never accept ACL targets outside the freshly allocated tree. Reject all
// reparse points, including junctions (std::is_symlink alone is insufficient).
fn checked(root: &Path, path: &Path) -> Result<PathBuf> {
    let canonical_root = io(root.canonicalize())?;
    let canonical = io(path.canonicalize())?;
    if !canonical.starts_with(&canonical_root) {
        return Err("ACL/path target escaped temporary root".into());
    }
    let mut current = root.to_path_buf();
    if io(fs::symlink_metadata(&current))?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("reparse root rejected".into());
    }
    for component in path
        .strip_prefix(root)
        .map_err(|_| "non lexical descendant")?
        .components()
    {
        if !matches!(component, Component::Normal(_)) {
            return Err("non-normal path rejected".into());
        }
        current.push(component);
        if io(fs::symlink_metadata(&current))?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err("reparse target rejected".into());
        }
    }
    Ok(canonical)
}
fn copy_tree(source: &Path, destination: &Path) -> Result<()> {
    let meta = io(fs::symlink_metadata(source))?;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(format!(
            "runtime reparse point rejected: {}",
            source.display()
        ));
    }
    if meta.is_dir() {
        io(fs::create_dir(destination))?;
        for entry in io(fs::read_dir(source))? {
            let e = io(entry)?;
            copy_tree(&e.path(), &destination.join(e.file_name()))?;
        }
    } else if meta.is_file() {
        io(fs::copy(source, destination))?;
    } else {
        return Err("non-regular runtime entry rejected".into());
    }
    Ok(())
}
fn grant(root: &Path, path: &Path, sid: PSID, rights: u32) -> Result<()> {
    let target = wide(checked(root, path)?);
    unsafe {
        let mut old_acl = null_mut();
        let mut descriptor = null_mut();
        let code = GetNamedSecurityInfoW(
            target.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            &mut old_acl,
            null_mut(),
            &mut descriptor,
        );
        if code != 0 {
            return Err(format!("GetNamedSecurityInfoW: {code}"));
        }
        let mut entry: EXPLICIT_ACCESS_W = zeroed();
        entry.grfAccessPermissions = rights;
        entry.grfAccessMode = GRANT_ACCESS;
        // Explicitly set each new object, never mutate inheritance on ancestors.
        entry.grfInheritance = NO_INHERITANCE;
        entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        entry.Trustee.TrusteeType = TRUSTEE_IS_UNKNOWN;
        entry.Trustee.ptstrName = sid.cast();
        let mut acl = null_mut();
        let code = SetEntriesInAclW(1, &entry, old_acl, &mut acl);
        let result = if code != 0 {
            Err(format!("SetEntriesInAclW: {code}"))
        } else {
            let code = SetNamedSecurityInfoW(
                target.as_ptr(),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION,
                null_mut(),
                null_mut(),
                acl,
                null_mut(),
            );
            if code == 0 {
                Ok(())
            } else {
                Err(format!("SetNamedSecurityInfoW: {code}"))
            }
        };
        if !acl.is_null() {
            LocalFree(acl.cast());
        }
        LocalFree(descriptor);
        result
    }
}
fn grant_tree(root: &Path, path: &Path, sid: PSID, rights: u32) -> Result<()> {
    grant(root, path, sid, rights)?;
    if path.is_dir() {
        for entry in io(fs::read_dir(path))? {
            grant_tree(root, &io(entry)?.path(), sid, rights)?;
        }
        // New descendants in writable trees must inherit the same package SID.
        // Existing children already received explicit grants above.
        if rights & FILE_GENERIC_WRITE == FILE_GENERIC_WRITE {
            let target = wide(checked(root, path)?);
            unsafe {
                let mut old = null_mut();
                let mut sd = null_mut();
                let code = GetNamedSecurityInfoW(
                    target.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    &mut old,
                    null_mut(),
                    &mut sd,
                );
                if code != 0 {
                    return Err(format!("GetNamedSecurityInfoW inheritance: {code}"));
                }
                let mut e: EXPLICIT_ACCESS_W = zeroed();
                e.grfAccessPermissions = rights;
                e.grfAccessMode = GRANT_ACCESS;
                e.grfInheritance = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
                e.Trustee.TrusteeForm = TRUSTEE_IS_SID;
                e.Trustee.ptstrName = sid.cast();
                let mut acl = null_mut();
                let mut code = SetEntriesInAclW(1, &e, old, &mut acl);
                if code == 0 {
                    code = SetNamedSecurityInfoW(
                        target.as_ptr(),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION,
                        null_mut(),
                        null_mut(),
                        acl,
                        null_mut(),
                    );
                }
                if !acl.is_null() {
                    LocalFree(acl.cast());
                }
                LocalFree(sd);
                if code != 0 {
                    return Err(format!("set inheritance: {code}"));
                }
            }
        }
    }
    Ok(())
}
struct Attributes {
    storage: Vec<usize>,
    initialized: bool,
}
impl Attributes {
    fn new(count: u32) -> Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(win_error("attribute size"));
        }
        let mut result = Self {
            storage: vec![0; bytes.div_ceil(size_of::<usize>())],
            initialized: false,
        };
        if unsafe { InitializeProcThreadAttributeList(result.ptr(), count, 0, &mut bytes) } == 0 {
            return Err(win_error("attribute init"));
        }
        result.initialized = true;
        Ok(result)
    }
    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.storage.as_mut_ptr().cast()
    }
    fn set(&mut self, key: u32, ptr: *const c_void, bytes: usize) -> Result<()> {
        if unsafe {
            UpdateProcThreadAttribute(self.ptr(), 0, key as usize, ptr, bytes, null_mut(), null())
        } == 0
        {
            Err(win_error("attribute update"))
        } else {
            Ok(())
        }
    }
}
impl Drop for Attributes {
    fn drop(&mut self) {
        if self.initialized {
            unsafe {
                DeleteProcThreadAttributeList(self.ptr());
            }
        }
    }
}
struct KillJob(Handle);
impl KillJob {
    fn terminate_and_wait(&self) -> Result<()> {
        if unsafe { TerminateJobObject(self.0 .0, 137) } == 0 {
            return Err(win_error("TerminateJobObject"));
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { zeroed() };
            if unsafe {
                QueryInformationJobObject(
                    self.0 .0,
                    JobObjectBasicAccountingInformation,
                    (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of_val(&accounting) as u32,
                    null_mut(),
                )
            } == 0
            {
                return Err(win_error("QueryInformationJobObject cleanup"));
            }
            if accounting.ActiveProcesses == 0 {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err("Job cleanup unconfirmed: descendants still active".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}
impl Drop for KillJob {
    fn drop(&mut self) {
        unsafe {
            TerminateJobObject(self.0 .0, 137);
        }
    }
}

fn limited_log(path: &Path) -> Result<String> {
    let mut out = Vec::new();
    io(io(File::open(path))?.take(65536).read_to_end(&mut out))?;
    Ok(String::from_utf8_lossy(&out).into_owned())
}
fn launch(
    root: &Path,
    identity: &Identity,
    options: &Options,
    exe: &Path,
    args: &[String],
    env: &[u16],
    index: usize,
) -> Result<Value> {
    let stdout_path = root.join(format!("stdout-{index}.log"));
    let stderr_path = root.join(format!("stderr-{index}.log"));
    let stdout = io(File::create(&stdout_path))?;
    let stderr = io(File::create(&stderr_path))?;
    let stdin = io(File::open(root.join("stdin-empty")))?;
    let handles = [
        stdin.as_raw_handle() as HANDLE,
        stdout.as_raw_handle() as HANDLE,
        stderr.as_raw_handle() as HANDLE,
    ];
    for h in handles {
        if unsafe { SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
            return Err(win_error("inherit handle"));
        }
    }
    let mut attributes = Attributes::new(1)?;
    attributes.set(
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        handles.as_ptr().cast(),
        size_of_val(&handles),
    )?;
    unsafe {
        let job = CreateJobObjectW(null(), null());
        if job.is_null() {
            return Err(win_error("CreateJobObjectW"));
        }
        let job = KillJob(Handle(job));
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if SetInformationJobObject(
            job.0 .0,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of_val(&limits) as u32,
        ) == 0
        {
            return Err(win_error("SetInformationJobObject"));
        }
        let mut si: STARTUPINFOEXW = zeroed();
        si.StartupInfo.cb = size_of_val(&si) as u32;
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.lpDesktop = identity.desktop_name.as_ptr().cast_mut();
        si.StartupInfo.hStdInput = handles[0];
        si.StartupInfo.hStdOutput = handles[1];
        si.StartupInfo.hStdError = handles[2];
        si.lpAttributeList = attributes.ptr();
        let exe_w = wide(exe);
        let mut command = wide(
            std::iter::once(exe.to_string_lossy().into_owned())
                .chain(args.iter().cloned())
                .map(|a| quote_arg(&a))
                .collect::<Vec<_>>()
                .join(" "),
        );
        let cwd = wide(root.join("workspace"));
        let mut pi: PROCESS_INFORMATION = zeroed();
        // The isolated CI coordinator already has SeImpersonatePrivilege, but
        // not SeAssignPrimaryTokenPrivilege (first run failed with 1314).
        // Launch the SAME restricted primary token via secondary logon; this
        // is the sole API, never a retry with a host/unrestricted token.
        // Explicit desktop avoids the API's implicit desktop ACL adjustment.
        if CreateProcessWithTokenW(
            identity.token.0,
            0, // Do not load a user profile or use NETCREDENTIALS_ONLY.
            exe_w.as_ptr(),
            command.as_mut_ptr(),
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_SUSPENDED
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW,
            env.as_ptr().cast(),
            cwd.as_ptr(),
            &mut si.StartupInfo,
            &mut pi,
        ) == 0
        {
            return Err(win_error("CreateProcessWithTokenW (no host fallback)"));
        }
        let process = Handle(pi.hProcess);
        let thread = Handle(pi.hThread);
        if AssignProcessToJobObject(job.0 .0, process.0) == 0 {
            let e = win_error("AssignProcessToJobObject");
            if TerminateProcess(process.0, 137) == 0
                || WaitForSingleObject(process.0, 5000) != WAIT_OBJECT_0
            {
                return Err(format!("{e}; suspended process cleanup unconfirmed"));
            }
            return Err(e);
        }
        let proof = match identity.proof(process.0) {
            Ok(proof) => proof,
            Err(error) => {
                job.terminate_and_wait()?;
                return Err(error);
            }
        };
        if ResumeThread(thread.0) == u32::MAX {
            let error = win_error("ResumeThread");
            job.terminate_and_wait()?;
            return Err(error);
        }
        let wait = WaitForSingleObject(process.0, (options.timeout_seconds * 1000) as u32);
        let timeout = wait == WAIT_TIMEOUT;
        if wait != WAIT_OBJECT_0 && !timeout {
            let error = win_error("WaitForSingleObject");
            job.terminate_and_wait()?;
            return Err(error);
        }
        let mut code = 0;
        if GetExitCodeProcess(process.0, &mut code) == 0 {
            let error = win_error("GetExitCodeProcess");
            job.terminate_and_wait()?;
            return Err(error);
        }
        // Descendants must not outlive the probe, even when the launcher exits.
        job.terminate_and_wait()?;
        let output = limited_log(&stdout_path)?;
        let parsed: Option<Value> = output
            .lines()
            .rev()
            .find_map(|line| serde_json::from_str(line).ok());
        let checks_ok = parsed
            .as_ref()
            .and_then(|v| v["checks"].as_array())
            .is_some_and(|checks| {
                !checks.is_empty() && checks.iter().all(|c| c["status"] == "passed")
            });
        Ok(
            json!({"executable":exe,"args":args,"token":proof,"exit_code":code,"timeout":timeout,
            "stdout":output,"stderr":limited_log(&stderr_path)?,"script_result":parsed,
            "job_active_processes_after_cleanup":0,"passed":!timeout && code == 0 && checks_ok}),
        )
    }
}
fn manifest_path(runtime: &Path, manifest: &Value, pointer: &str) -> Result<PathBuf> {
    let value = manifest
        .pointer(pointer)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("manifest missing {pointer}"))?;
    let relative = Path::new(value);
    if relative
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(format!("unsafe manifest path: {pointer}"));
    }
    let path = runtime.join(relative);
    checked(runtime, &path)?;
    Ok(path)
}
fn digest(path: &Path) -> Result<String> {
    let mut file = io(File::open(path))?;
    let mut hash = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = io(file.read(&mut buf))?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
#[derive(Serialize)]
pub struct Report {
    pub passed: bool,
    platform: &'static str,
    evidence: Value,
    error: Option<String>,
    cleanup: Value,
}

pub fn run(options: Options) -> Report {
    let mut report = Report {
        passed: false,
        platform: std::env::consts::ARCH,
        evidence: json!({}),
        error: None,
        cleanup: json!({}),
    };
    if !cfg!(target_arch = "x86_64") {
        report.error = Some("Only Windows x64 supported by this probe".into());
        return report;
    }
    let temp = match tempfile::Builder::new()
        .prefix("Hatch probe 中文 ")
        .tempdir()
    {
        Ok(t) => t,
        Err(e) => {
            report.error = Some(e.to_string());
            return report;
        }
    };
    let root = temp.path().to_path_buf();
    let mut profile = None;
    let outcome = (|| -> Result<bool> {
        let runtime = root.join("runtime");
        eprintln!(
            "Copying runtime read-only source into {}",
            runtime.display()
        );
        copy_tree(&options.runtime_root, &runtime)?;
        let manifest_file = runtime.join("manifest.json");
        let manifest: Value =
            serde_json::from_slice(&io(fs::read(&manifest_file))?).map_err(|e| e.to_string())?;
        let node = manifest_path(&runtime, &manifest, "/node/executable")?;
        let python = manifest_path(&runtime, &manifest, "/python/executable")?;
        let soffice = manifest_path(&runtime, &manifest, "/native/binaries/soffice")?;
        let python_packages = manifest_path(&runtime, &manifest, "/python/package_root")?;
        let node_modules = manifest_path(&runtime, &manifest, "/node/module_root")?;
        for exe in [&node, &python, &soffice] {
            if !exe.is_file()
                || !matches!(
                    exe.extension().and_then(|s| s.to_str()),
                    Some("exe" | "com")
                )
            {
                return Err(format!(
                    "Windows native executable required: {}",
                    exe.display()
                ));
            }
        }
        for dir in [
            "workspace",
            "scratch",
            "attachments",
            "ungranted",
            "scripts",
        ] {
            io(fs::create_dir(root.join(dir)))?;
        }
        io(fs::write(root.join("stdin-empty"), b""))?;
        for dir in ["runtime", "attachments"] {
            io(fs::write(
                root.join(dir).join("probe-canary.txt"),
                b"readonly",
            ))?;
        }
        io(fs::write(
            root.join("ungranted/secret.txt"),
            b"synthetic-not-real-credentials",
        ))?;
        io(fs::write(
            root.join("ungranted/internal.db"),
            b"synthetic-internal-db-not-user-data",
        ))?;
        io(fs::write(
            root.join("scripts/boundary.py"),
            include_str!("../scripts/boundary.py"),
        ))?;
        io(fs::write(
            root.join("scripts/boundary.cjs"),
            include_str!("../scripts/boundary.cjs"),
        ))?;
        io(fs::write(
            root.join("scripts/boundary.ps1"),
            include_str!("../scripts/boundary.ps1"),
        ))?;
        let name = format!(
            "HatchProbeDesktop_{}_{}",
            std::process::id(),
            root.file_name()
                .unwrap()
                .to_string_lossy()
                .split_whitespace()
                .last()
                .unwrap()
        );
        profile = Some(Identity::create(&name, &options.identity_user)?);
        let p = profile.as_ref().unwrap();
        grant(&root, &root, p.sid, FILE_TRAVERSE)?;
        for dir in ["runtime", "attachments", "scripts"] {
            grant_tree(
                &root,
                &root.join(dir),
                p.sid,
                FILE_GENERIC_READ | FILE_GENERIC_EXECUTE,
            )?;
        }
        for dir in ["workspace", "scratch"] {
            grant_tree(
                &root,
                &root.join(dir),
                p.write_sid,
                FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_GENERIC_WRITE | DELETE,
            )?;
            grant_tree(
                &root,
                &root.join(dir),
                p.sid,
                FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_GENERIC_WRITE | DELETE,
            )?;
        }
        let mut system_buf = vec![0u16; 32768];
        let n = unsafe { GetSystemDirectoryW(system_buf.as_mut_ptr(), system_buf.len() as u32) }
            as usize;
        if n == 0 || n >= system_buf.len() {
            return Err(win_error("GetSystemDirectoryW"));
        }
        let system = PathBuf::from(String::from_utf16_lossy(&system_buf[..n]));
        let ps = system.join("WindowsPowerShell/v1.0/powershell.exe");
        let scratch = root.join("scratch").display().to_string();
        let vars = vec![
            (
                "SystemRoot",
                system
                    .parent()
                    .ok_or("no Windows directory")?
                    .display()
                    .to_string(),
            ),
            (
                "PATH",
                format!(
                    "{};{};{};{}",
                    system.display(),
                    node.parent().unwrap().display(),
                    python.parent().unwrap().display(),
                    soffice.parent().unwrap().display()
                ),
            ),
            ("TEMP", scratch.clone()),
            ("PATHEXT", ".COM;.EXE;.BAT;.CMD".into()),
            ("TMP", scratch.clone()),
            ("USERPROFILE", scratch.clone()),
            ("APPDATA", scratch.clone()),
            ("LOCALAPPDATA", scratch),
            ("PYTHONNOUSERSITE", "1".into()),
            ("PYTHONDONTWRITEBYTECODE", "1".into()),
            ("PYTHONPATH", python_packages.display().to_string()),
            ("NODE_PATH", node_modules.display().to_string()),
        ];
        let env = super::environment::block(vars)?;
        report.evidence = json!({"temporary_root":root,"private_desktop":name,"identity_kind":"dedicated restricted user","product_isolation_complete":false,"manifest_sha256":digest(&manifest_file)?,
            "runtime_source":options.runtime_root,"binaries_sha256":{"node":digest(&node)?,"python":digest(&python)?,"soffice":digest(&soffice)?},"processes":[]});
        let root_arg = root.display().to_string();
        let jobs = vec![
            (
                ps,
                vec![
                    "-NoLogo".into(),
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-File".into(),
                    root.join("scripts/boundary.ps1").display().to_string(),
                    root_arg.clone(),
                ],
            ),
            (
                node,
                vec![
                    root.join("scripts/boundary.cjs").display().to_string(),
                    root_arg.clone(),
                ],
            ),
            (
                python.clone(),
                vec![
                    root.join("scripts/boundary.py").display().to_string(),
                    root_arg.clone(),
                    soffice.display().to_string(),
                ],
            ),
        ];
        let mut passed = true;
        for (index, (exe, args)) in jobs.iter().enumerate() {
            eprintln!("Probing {} (dedicated restricted identity)", exe.display());
            let result = launch(&root, p, &options, exe, args, &env, index)
                .unwrap_or_else(|e| json!({"executable":exe,"passed":false,"error":e}));
            passed &= result["passed"] == true;
            report.evidence["processes"]
                .as_array_mut()
                .unwrap()
                .push(result);
        }
        let source = root.join("workspace/formula.xlsx");
        if source.is_file() {
            io(fs::copy(&source, root.join("ungranted/hidden.xlsx")))?;
            let attachment = root.join("attachments/allowed.xlsx");
            io(fs::copy(&source, &attachment))?;
            grant(&root, &attachment, p.sid, FILE_GENERIC_READ)?;
            let args = vec![
                root.join("scripts/boundary.py").display().to_string(),
                root_arg,
                soffice.display().to_string(),
                "lo-negative".into(),
            ];
            let result = launch(&root, p, &options, &python, &args, &env, 3)
                .unwrap_or_else(|e| json!({"passed":false,"error":e}));
            passed &= result["passed"] == true;
            report.evidence["processes"]
                .as_array_mut()
                .unwrap()
                .push(result);
        } else {
            passed = false;
            report.evidence["lo_negative"] = json!("not run: positive input missing");
        }
        let mut host_checks = Vec::new();
        let secret_intact =
            io(fs::read(root.join("ungranted/secret.txt")))? == b"synthetic-not-real-credentials";
        let db_intact = io(fs::read(root.join("ungranted/internal.db")))?
            == b"synthetic-internal-db-not-user-data";
        passed &= db_intact;
        host_checks.push(json!({"name":"synthetic internal DB unchanged","passed":db_intact}));
        passed &= secret_intact;
        host_checks
            .push(json!({"name":"synthetic ungranted canary unchanged","passed":secret_intact}));
        for dir in ["runtime", "attachments"] {
            let intact = io(fs::read(root.join(dir).join("probe-canary.txt")))? == b"readonly";
            passed &= intact;
            host_checks.push(json!({"name":format!("{dir} canary unchanged"),"passed":intact}));
        }
        for name in ["powershell", "node", "python"] {
            let ok = fs::read_to_string(root.join("workspace").join(format!("{name}-marker")))
                .is_ok_and(|s| s == format!("{name}-ok"));
            passed &= ok;
            host_checks.push(json!({"name":format!("{name} actual marker"),"passed":ok}));
        }
        let no_escape = !root.join("attachments/formula.xlsx").exists()
            && !root.join("runtime/formula.xlsx").exists()
            && !root.join("workspace/negative/hidden.xlsx").exists();
        passed &= no_escape;
        host_checks.push(json!({"name":"LO forbidden outputs absent (not alone proof of deny)","passed":no_escape}));
        report.evidence["host_checks"] = json!(host_checks);
        Ok(passed)
    })();
    match outcome {
        Ok(passed) => report.passed = passed,
        Err(e) => report.error = Some(e),
    }
    let profile_created = profile.is_some();
    let profile_cleanup = profile
        .as_mut()
        .map(Identity::close_desktop)
        .unwrap_or(Ok(()));
    let directory_cleanup = temp.close().map_err(|e| e.to_string());
    report.passed &= profile_cleanup.is_ok() && directory_cleanup.is_ok();
    report.cleanup = json!({"identity_opened":profile_created,"private_desktop_closed":profile_created && profile_cleanup.is_ok(),"desktop_error":profile_cleanup.err(),"account_cleanup":"owned by CI provisioner; probe never creates/deletes accounts or profiles","temporary_directory_deleted":directory_cleanup.is_ok(),"directory_error":directory_cleanup.err(),"path":root});
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    // These tests create files only; no profiles, ACL changes or child launch.
    #[test]
    fn acl_guard_rejects_outside_and_parent_paths() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        assert!(checked(root.path(), outside.path()).is_err());
        assert!(checked(root.path(), &root.path().join("..")).is_err());
        assert!(checked(root.path(), root.path()).is_ok());
    }
    #[test]
    fn manifest_paths_cannot_escape_or_use_absolute_paths() {
        let root = tempfile::tempdir().unwrap();
        for path in [
            "../secret",
            "C:\\secret",
            "\\\\server\\share\\exe",
            "folder/../secret",
        ] {
            assert!(manifest_path(root.path(), &json!({"exe":path}), "/exe").is_err());
        }
        fs::write(root.path().join("node.exe"), b"test only").unwrap();
        assert!(manifest_path(root.path(), &json!({"exe":"node.exe"}), "/exe").is_ok());
    }
}
