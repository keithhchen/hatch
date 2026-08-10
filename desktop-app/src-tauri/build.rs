use std::env;

const PERSISTENT_SESSION_SWITCH: &str = "HATCH_PERSISTENT_SESSION";
const APPLE_TEAM_ID: &str = "HATCH_APPLE_TEAM_ID";

fn main() {
    // A normal `tauri dev` build and every ad-hoc/UAT bundle deliberately use
    // an in-process session only. They must not read, migrate, update, or
    // delete a Login Keychain item created by another temporary Hatch binary.
    //
    // The release workflow opts in explicitly and supplies the Team ID that
    // the executable must prove at runtime before it can use Keychain. Keeping
    // this as a compile-time capability prevents a user-controlled renderer or
    // runtime environment from changing storage policy after launch.
    println!("cargo:rerun-if-env-changed={PERSISTENT_SESSION_SWITCH}");
    println!("cargo:rerun-if-env-changed={APPLE_TEAM_ID}");
    let persistent_session = env::var(PERSISTENT_SESSION_SWITCH).ok().as_deref() == Some("1");
    println!(
        "cargo:rustc-env={PERSISTENT_SESSION_SWITCH}={}",
        if persistent_session { "1" } else { "0" }
    );

    if persistent_session && env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let team_id = env::var(APPLE_TEAM_ID)
            .expect("HATCH_APPLE_TEAM_ID is required when persistent macOS sessions are enabled");
        assert!(
            is_apple_team_id(&team_id),
            "HATCH_APPLE_TEAM_ID must be the 10-character Apple Developer Team ID"
        );
        println!("cargo:rustc-env={APPLE_TEAM_ID}={team_id}");
    }

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "default_workspace",
            "ensure_workspace",
            "pick_workspace_folder",
            "reveal_workspace_artifact",
            "request_window_attention",
            "set_window_tool_context",
            "clear_window_tool_context",
            "execute_tool_call",
            "approve_pending_tool_call",
            "deny_pending_tool_call",
            "cancel_tool_call",
            "poll_tool_call",
            "read_auth_token",
            "write_auth_token",
            "clear_auth_token",
            "read_app_settings",
            "write_app_settings",
            "read_window_settings",
            "patch_window_settings",
            "open_conversation_window",
            "open_settings_window",
            "open_about_window",
            "set_native_command_state",
            "show_native_command_menu",
            "show_native_context_menu",
            "open_external_url",
            "revoke_workspace_grant",
        ]),
    ))
    .expect("failed to build Hatch Tauri permissions");
}

fn is_apple_team_id(value: &str) -> bool {
    value.len() == 10
        && value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit())
}

#[cfg(test)]
mod tests {
    use super::is_apple_team_id;

    #[test]
    fn only_accepts_the_fixed_width_apple_team_id_format() {
        assert!(is_apple_team_id("AB12CD34EF"));
        assert!(!is_apple_team_id("AB12CD34E"));
        assert!(!is_apple_team_id("ab12cd34ef"));
        assert!(!is_apple_team_id("AB12-CD34E"));
    }
}
