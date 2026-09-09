// Adapted from OpenAI Codex token.rs / desktop.rs, Apache-2.0.
// Copyright 2025 OpenAI. Hatch modifications: see NOTICE and LICENSE-CODEX.
// Dedicated *preprovisioned* test identity only; never derive from the host user.
use super::*;
use windows_sys::Win32::System::StationsAndDesktops::*;
use windows_sys::Win32::System::SystemServices::SECURITY_DESCRIPTOR_REVISION;
const SE_GROUP_LOGON_ID: u32 = 0xc0000000;

pub(crate) struct Identity {
    pub token: Handle,
    pub sid: PSID,
    pub write_sid: PSID,
    user_buffer: Vec<usize>,
    desktop: HDESK,
    pub desktop_name: Vec<u16>,
}

fn token_info(token: HANDLE, class: TOKEN_INFORMATION_CLASS) -> Result<Vec<usize>> {
    let mut size = 0;
    unsafe {
        GetTokenInformation(token, class, null_mut(), 0, &mut size);
    }
    if size == 0 {
        return Err(win_error("token information size"));
    }
    let mut data = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
    if unsafe { GetTokenInformation(token, class, data.as_mut_ptr().cast(), size, &mut size) } == 0
    {
        return Err(win_error("token information"));
    }
    Ok(data)
}

fn groups(data: &[usize]) -> &[SID_AND_ATTRIBUTES] {
    // Buffer is aligned and returned by GetTokenInformation, not external input.
    unsafe {
        let g = &*data.as_ptr().cast::<TOKEN_GROUPS>();
        std::slice::from_raw_parts(g.Groups.as_ptr(), g.GroupCount as usize)
    }
}

impl Identity {
    pub fn create(name: &str, account: &str) -> Result<Self> {
        if !account.starts_with("HatchProbe_")
            || account.len() > 20
            || !account
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_')
        {
            return Err(
                "Only an explicitly provisioned local HatchProbe_* test account is accepted".into(),
            );
        }
        let password = std::env::var_os("HATCH_PROBE_PASSWORD")
            .ok_or("HATCH_PROBE_PASSWORD is required; no host-token fallback")?;
        let mut password = wide(password);
        let mut base = null_mut();
        let logged_on = unsafe {
            LogonUserW(
                wide(account).as_ptr(),
                wide(".").as_ptr(),
                password.as_ptr(),
                LOGON32_LOGON_INTERACTIVE,
                LOGON32_PROVIDER_DEFAULT,
                &mut base,
            )
        };
        let login_error = win_error("LogonUserW test identity");
        // No password in argv, reports, files, or child environment.
        for word in &mut password {
            unsafe {
                std::ptr::write_volatile(word, 0);
            }
        }
        if logged_on == 0 {
            return Err(login_error);
        }
        let base = Handle(base);
        let user_buffer = token_info(base.0, TokenUser)?;
        let sid = unsafe { (*user_buffer.as_ptr().cast::<TOKEN_USER>()).User.Sid };
        let mut host = null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut host) } == 0 {
            return Err(win_error("host token query"));
        }
        let host = Handle(host);
        let host_user = token_info(host.0, TokenUser)?;
        let host_sid = unsafe { (*host_user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
        if unsafe { EqualSid(sid, host_sid) } != 0 {
            return Err("Test identity must differ from the host account".into());
        }
        let base_groups = token_info(base.0, TokenGroups)?;
        let logon = groups(&base_groups)
            .iter()
            .find(|g| g.Attributes & SE_GROUP_LOGON_ID == SE_GROUP_LOGON_ID)
            .ok_or("Test account has no logon SID")?
            .Sid;
        if groups(&base_groups)
            .iter()
            .any(|g| unsafe { IsWellKnownSid(g.Sid, WinBuiltinAdministratorsSid) } != 0)
        {
            return Err(
                "Administrator test identity rejected, including deny-only membership".into(),
            );
        }
        // Unique synthetic capability; never used as a real account identity.
        let hash = Sha256::digest(name.as_bytes());
        let parts: Vec<_> = hash[..16]
            .chunks_exact(4)
            .map(|b| u32::from_le_bytes(b.try_into().unwrap()).to_string())
            .collect();
        let mut write_sid = null_mut();
        if unsafe {
            ConvertStringSidToSidW(
                wide(format!("S-1-5-21-{}", parts.join("-"))).as_ptr(),
                &mut write_sid,
            )
        } == 0
        {
            return Err(win_error("capability SID"));
        }
        let mut identity = Self {
            token: Handle(null_mut()),
            sid,
            write_sid,
            user_buffer,
            desktop: null_mut(),
            desktop_name: wide(name),
        };
        let mut world = [0u8; SECURITY_MAX_SID_SIZE as usize];
        let mut world_size = world.len() as u32;
        if unsafe {
            CreateWellKnownSid(
                WinWorldSid,
                null_mut(),
                world.as_mut_ptr().cast(),
                &mut world_size,
            )
        } == 0
        {
            return Err(win_error("world SID"));
        }
        // Codex elevated model: read access is constrained by the dedicated
        // user, not WRITE_RESTRICTED. Capability constrains the write check.
        let entries =
            [write_sid, sid, logon, world.as_mut_ptr().cast()].map(|sid| SID_AND_ATTRIBUTES {
                Sid: sid,
                Attributes: 0,
            });
        let mut restricted = null_mut();
        if unsafe {
            CreateRestrictedToken(
                base.0,
                DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
                0,
                null(),
                0,
                null(),
                entries.len() as u32,
                entries.as_ptr(),
                &mut restricted,
            )
        } == 0
        {
            return Err(win_error("CreateRestrictedToken"));
        }
        identity.token = Handle(restricted);
        // Default DACL applies only to NEW objects created by this token.
        // It does not mutate any existing user/system object's ACL.
        let acl_entries: Vec<EXPLICIT_ACCESS_W> = [sid, logon, write_sid]
            .iter()
            .map(|sid| {
                let mut e: EXPLICIT_ACCESS_W = unsafe { zeroed() };
                e.grfAccessPermissions = GENERIC_ALL;
                e.grfAccessMode = GRANT_ACCESS;
                e.Trustee.TrusteeForm = TRUSTEE_IS_SID;
                e.Trustee.ptstrName = (*sid).cast();
                e
            })
            .collect();
        let mut acl = null_mut();
        let code = unsafe {
            SetEntriesInAclW(
                acl_entries.len() as u32,
                acl_entries.as_ptr(),
                null(),
                &mut acl,
            )
        };
        if code != 0 {
            return Err(format!("default DACL: {code}"));
        }
        let info = TOKEN_DEFAULT_DACL { DefaultDacl: acl };
        let ok = unsafe {
            SetTokenInformation(
                restricted,
                TokenDefaultDacl,
                (&info as *const TOKEN_DEFAULT_DACL).cast(),
                size_of::<TOKEN_DEFAULT_DACL>() as u32,
            )
        };
        let error = win_error("set token default DACL");
        unsafe {
            LocalFree(acl.cast());
        }
        if ok == 0 {
            return Err(error);
        }
        // Separate non-interactive desktop. Never modify Winsta0/Default ACL.
        // Dedicated user + capability get participant rights, not WRITE_DAC.
        let participant = DESKTOP_READOBJECTS
            | DESKTOP_CREATEWINDOW
            | DESKTOP_CREATEMENU
            | DESKTOP_ENUMERATE
            | DESKTOP_WRITEOBJECTS;
        let mut desktop_entries = acl_entries;
        for e in &mut desktop_entries {
            e.grfAccessPermissions = participant;
        }
        let mut owner: EXPLICIT_ACCESS_W = unsafe { zeroed() };
        owner.grfAccessPermissions = GENERIC_ALL;
        owner.grfAccessMode = GRANT_ACCESS;
        owner.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        owner.Trustee.ptstrName = host_sid.cast();
        desktop_entries.push(owner);
        let mut desktop_acl = null_mut();
        let code = unsafe {
            SetEntriesInAclW(
                desktop_entries.len() as u32,
                desktop_entries.as_ptr(),
                null(),
                &mut desktop_acl,
            )
        };
        if code != 0 {
            return Err(format!("private desktop ACL: {code}"));
        }
        let mut sd: SECURITY_DESCRIPTOR = unsafe { zeroed() };
        let ok = unsafe {
            InitializeSecurityDescriptor(
                (&mut sd as *mut SECURITY_DESCRIPTOR).cast(),
                SECURITY_DESCRIPTOR_REVISION,
            ) != 0
                && SetSecurityDescriptorDacl(
                    (&mut sd as *mut SECURITY_DESCRIPTOR).cast(),
                    1,
                    desktop_acl,
                    0,
                ) != 0
        };
        if !ok {
            unsafe {
                LocalFree(desktop_acl.cast());
            }
            return Err(win_error("desktop descriptor"));
        }
        let sa = SECURITY_ATTRIBUTES {
            nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: (&mut sd as *mut SECURITY_DESCRIPTOR).cast(),
            bInheritHandle: 0,
        };
        identity.desktop = unsafe {
            CreateDesktopW(
                identity.desktop_name.as_ptr(),
                null(),
                null(),
                0,
                GENERIC_ALL,
                &sa,
            )
        };
        let error = win_error("CreateDesktopW; no shared desktop fallback");
        unsafe {
            LocalFree(desktop_acl.cast());
        }
        if identity.desktop.is_null() {
            return Err(error);
        }
        identity.desktop_name = wide(format!("Winsta0\\{name}"));
        Ok(identity)
    }

    pub fn proof(&self, process: HANDLE) -> Result<Value> {
        let mut token = null_mut();
        if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
            return Err(win_error("child token query"));
        }
        let token = Handle(token);
        let user = token_info(token.0, TokenUser)?;
        let child_sid = unsafe { (*user.as_ptr().cast::<TOKEN_USER>()).User.Sid };
        let restrictions = token_info(token.0, TokenRestrictedSids)?;
        let capability = groups(&restrictions)
            .iter()
            .any(|g| unsafe { EqualSid(g.Sid, self.write_sid) } != 0);
        if unsafe { EqualSid(child_sid, self.sid) } == 0
            || !capability
            || unsafe { IsTokenRestricted(token.0) } == 0
        {
            return Err("Restricted child token identity mismatch; never resumed".into());
        }
        Ok(
            json!({"dedicated_user_matches":true,"restricted":true,"write_capability_matches":true,
            "checked_before_resume":true,"read_boundary":"dedicated user ACL, not WRITE_RESTRICTED"}),
        )
    }
    pub fn close_desktop(&mut self) -> Result<()> {
        if self.desktop.is_null() {
            return Ok(());
        }
        if unsafe { CloseDesktop(self.desktop) } == 0 {
            return Err(win_error("CloseDesktop"));
        }
        self.desktop = null_mut();
        Ok(())
    }
}
impl Drop for Identity {
    fn drop(&mut self) {
        let _ = self.close_desktop();
        if !self.write_sid.is_null() {
            unsafe {
                LocalFree(self.write_sid);
            }
        }
        // Keeps TokenUser SID backing allocation alive through token/ACL setup.
        let _ = &self.user_buffer;
    }
}
