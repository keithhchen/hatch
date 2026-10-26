//! Native window construction shared by every Hatch window.
//!
//! Each window is created hidden with the saved theme already applied (window
//! appearance plus an initialization script that sets `data-theme` and
//! `color-scheme` before any page script runs). The renderer reveals it with
//! `app_ready` after its first frame, so the user never sees a blank WebView.

use std::{path::PathBuf, time::Duration};

use tauri::{
    utils::config::{WindowConfig, WindowEffectsConfig},
    webview::PageLoadEvent,
    window::{Effect, EffectState},
    AppHandle, Manager, Runtime, State, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::window_commands::NativeCommandRouter;

pub const MAIN_WINDOW_LABEL: &str = "main";
pub const WELCOME_WINDOW_LABEL: &str = "welcome";
const REVEAL_FALLBACK_DELAY: Duration = Duration::from_secs(2);

/// Saved app theme: `system`, `light` or `dark`.
pub fn normalize_theme(value: &str) -> &'static str {
    match value {
        "light" => "light",
        "dark" => "dark",
        _ => "system",
    }
}

fn saved_theme<R: Runtime>(app: &AppHandle<R>) -> &'static str {
    crate::desktop_state::read(app)
        .map(|state| normalize_theme(&state.preferences.theme))
        .unwrap_or("system")
}

/// Runs before any page script: resolve the saved theme into `data-theme`
/// and `color-scheme` so the first painted frame already uses its palette.
fn theme_initialization_script(theme: &str) -> String {
    format!(
        r#"(function(){{var t="{theme}";function apply(){{var r=document.documentElement;if(!r)return false;var d=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);r.dataset.theme=d?"dark":"light";r.style.colorScheme=d?"dark":"light";return true;}}if(!apply())document.addEventListener("readystatechange",apply,{{once:true}});}})();"#
    )
}

fn window_theme(theme: &str) -> Option<Theme> {
    match theme {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    }
}

fn window_effects() -> WindowEffectsConfig {
    #[cfg(target_os = "macos")]
    let (effects, state) = (
        vec![Effect::Sidebar],
        Some(EffectState::FollowsWindowActiveState),
    );
    // Mica only: Acrylic is documented to lag while dragging/resizing.
    #[cfg(not(target_os = "macos"))]
    let (effects, state) = (vec![Effect::Mica], None);
    WindowEffectsConfig {
        effects,
        state,
        radius: None,
        color: None,
    }
}

/// The single builder policy for main, conversation and welcome windows.
/// Windows are transparent so the platform material (macOS sidebar vibrancy,
/// Windows 11 Mica) is the backdrop; the renderer paints opaque content
/// surfaces itself, which is also what keeps text crisp on Windows.
pub fn prepare_window<'a, R: Runtime, M: Manager<R>>(
    app: &AppHandle<R>,
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    let theme = saved_theme(app);
    let builder = builder
        .initialization_script(theme_initialization_script(theme))
        .theme(window_theme(theme))
        .transparent(true)
        .effects(window_effects())
        .accept_first_mouse(true)
        .zoom_hotkeys_enabled(false)
        .visible(false)
        // Product windows never expose WebKit's Inspect Element affordance.
        .devtools(false);
    #[cfg(target_os = "macos")]
    let builder = builder.allow_link_preview(false);
    #[cfg(target_os = "windows")]
    let builder = builder.scroll_bar_style(tauri::utils::config::ScrollBarStyle::FluentOverlay);
    builder
}

/// A renderer reveals its window with `app_ready`. If it never does (a crash
/// during startup), show the window anyway so Hatch is never invisible. A
/// signed-out main window stays hidden on purpose while the welcome window
/// is up, so it is not forced on screen behind it.
pub fn reveal_if_still_hidden<R: Runtime>(window: WebviewWindow<R>) {
    std::thread::spawn(move || {
        std::thread::sleep(REVEAL_FALLBACK_DELAY);
        let waiting_for_sign_in = window.label() == MAIN_WINDOW_LABEL
            && window.app_handle().get_webview_window(WELCOME_WINDOW_LABEL).is_some();
        if !waiting_for_sign_in && !window.is_visible().unwrap_or(true) {
            let _ = window.show();
        }
    });
}

/// Build the configured `main` window (`create: false` in tauri.conf.json).
pub fn build_main_window<R: Runtime>(
    app: &AppHandle<R>,
    config: &WindowConfig,
) -> Result<(), String> {
    let builder = WebviewWindowBuilder::from_config(app, config)
        .map_err(|error| format!("native_window_create_failed: {error}"))?;
    prepare_window(app, builder)
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                reveal_if_still_hidden(window);
            }
        })
        .build()
        .map(|_| ())
        .map_err(|error| format!("native_window_create_failed: {error}"))
}

/// The renderer painted its first frame: reveal the invoking window. Once the
/// signed-in main window is visible the welcome window has done its job.
#[tauri::command]
pub fn app_ready(
    app: AppHandle,
    window: WebviewWindow,
    router: State<'_, NativeCommandRouter>,
) -> Result<(), String> {
    window
        .show()
        .and_then(|_| window.set_focus())
        .map_err(|error| format!("native_window_show_failed: {error}"))?;
    if window.label() == MAIN_WINDOW_LABEL {
        if let Some(welcome) = app.get_webview_window(WELCOME_WINDOW_LABEL) {
            welcome
                .close()
                .map_err(|error| format!("native_window_close_failed: {error}"))?;
        }
    }
    router.set_active_window(window.label());
    router.refresh_native_menu(&app)
}

/// The small fixed sign-in window. It only hands the user to the system
/// browser; the `hatch://auth/callback` deep link brings them back.
#[tauri::command]
pub fn open_welcome_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WELCOME_WINDOW_LABEL) {
        return window
            .show()
            .and_then(|_| window.set_focus())
            .map_err(|error| format!("native_window_show_failed: {error}"));
    }
    let builder = WebviewWindowBuilder::new(
        &app,
        WELCOME_WINDOW_LABEL,
        WebviewUrl::App(PathBuf::from("index.html?window=welcome")),
    );
    let builder = prepare_window(&app, builder)
        .title("Hatch")
        .inner_size(400.0, 480.0)
        .resizable(false)
        .maximizable(false)
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                reveal_if_still_hidden(window);
            }
        });
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);
    builder
        .build()
        .map(|_| ())
        .map_err(|error| format!("native_window_create_failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{normalize_theme, theme_initialization_script};

    #[test]
    fn theme_is_normalized_and_resolved_before_page_scripts() {
        assert_eq!(normalize_theme("dark"), "dark");
        assert_eq!(normalize_theme("light"), "light");
        assert_eq!(normalize_theme("sepia"), "system");
        let script = theme_initialization_script("system");
        assert!(script.contains(r#"var t="system""#));
        assert!(script.contains("prefers-color-scheme: dark"));
        assert!(script.contains("colorScheme"));
        assert!(script.contains("dataset.theme"));
    }
}
