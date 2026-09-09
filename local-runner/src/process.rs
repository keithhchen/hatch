use std::process::Command;

pub(crate) fn configure_background_process(command: &mut Command, platform_flags: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

        command.creation_flags(CREATE_NO_WINDOW | platform_flags);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (command, platform_flags);
    }
}
