//! Windows-specific persistence and revalidation for a Workspace grant.
//!
//! A Windows desktop build is not App Sandboxed, so it cannot retain a macOS
//! security-scoped bookmark (nor should it claim to). The native folder picker
//! is the consent event. We retain the canonical Windows path as UTF-16 in
//! native app data, then re-canonicalize and probe it before every use. The
//! renderer receives only an opaque `grant_id`; it never supplies this path to
//! an executor.

use std::ffi::OsString;
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsWorkspaceRoot {
    /// Lossless representation of the canonical root. `display_path` is only
    /// presentation data and must never be used to recover authority.
    pub(crate) canonical_path_utf16: Vec<u16>,
    pub(crate) display_path: String,
}

/// Converts the path returned by the Windows native folder picker into a
/// persistable, authoritative workspace root.
pub(crate) fn create_windows_workspace_root(
    selected_path: PathBuf,
) -> Result<WindowsWorkspaceRoot, String> {
    let canonical = canonicalize_and_probe(&selected_path)?;
    Ok(WindowsWorkspaceRoot {
        canonical_path_utf16: canonical.as_os_str().encode_wide().collect(),
        display_path: canonical.to_string_lossy().to_string(),
    })
}

/// Restores an unpackaged Windows workspace grant. A persisted grant is valid
/// only if it was written by the Windows backend and its canonical root still
/// resolves to exactly the same root with list access under the current ACL.
pub(crate) fn resolve_windows_workspace_root(
    native_platform: &str,
    canonical_path_utf16: &[u16],
) -> Result<PathBuf, String> {
    if native_platform != "windows" {
        return Err(
            "workspace_grant_stale: This workspace permission was not created by the Windows desktop app"
                .into(),
        );
    }
    if canonical_path_utf16.is_empty() {
        return Err(
            "workspace_grant_stale: The saved Windows workspace permission is incomplete; choose the folder again"
                .into(),
        );
    }

    let persisted = PathBuf::from(OsString::from_wide(canonical_path_utf16));
    let canonical = canonicalize_and_probe(&persisted).map_err(|error| {
        if error.starts_with("workspace_grant_invalid:") {
            error.replacen("workspace_grant_invalid:", "workspace_grant_stale:", 1)
        } else if error.starts_with("workspace_grant_denied:") {
            error.replacen("workspace_grant_denied:", "workspace_grant_stale:", 1)
        } else {
            error
        }
    })?;

    // A symlink/junction replacement or a moved directory must not silently
    // turn a stored grant into a grant for a different root. Re-selecting the
    // folder is the explicit consent recovery path.
    if canonical != persisted {
        return Err(
            "workspace_grant_stale: The saved Windows workspace path no longer resolves to its granted canonical root; choose the folder again"
                .into(),
        );
    }

    Ok(canonical)
}

fn canonicalize_and_probe(path: &Path) -> Result<PathBuf, String> {
    let canonical = path.canonicalize().map_err(|error| {
        format!(
            "workspace_grant_invalid: Hatch could not open the selected Windows folder: {error}"
        )
    })?;

    if !canonical.is_dir() {
        return Err(
            "workspace_grant_invalid: The selected Windows workspace must be an existing folder"
                .into(),
        );
    }
    // Windows `canonicalize` can produce a verbatim `\\?\C:\...` path. Check
    // components as well as `parent()` so drive and UNC-share roots cannot
    // evade the root guard through that representation.
    if is_windows_filesystem_root(&canonical) {
        return Err("workspace_grant_invalid: Choose a folder below the filesystem root".into());
    }

    // The user process may resolve metadata but still be denied directory-list
    // access by NTFS/share ACLs. Probe the same capability file_list needs on
    // every restore/execution; mutations remain subject to their own ACL at
    // operation time.
    let mut entries = std::fs::read_dir(&canonical).map_err(|error| {
        format!(
            "workspace_grant_denied: Windows denied read access to the selected folder: {error}"
        )
    })?;
    entries.next().transpose().map_err(|error| {
        format!(
            "workspace_grant_denied: Hatch could not enumerate the selected Windows folder: {error}"
        )
    })?;

    Ok(canonical)
}

fn is_windows_filesystem_root(path: &Path) -> bool {
    let mut components = path.components();
    let first = components.next();
    let second = components.next();
    let third = components.next();

    matches!(
        (first, second, third),
        (Some(Component::Prefix(_)), Some(Component::RootDir), None)
            | (Some(Component::RootDir), None, None)
    ) || path.parent().is_none()
}

#[cfg(test)]
mod tests {
    use super::{create_windows_workspace_root, resolve_windows_workspace_root};
    use tempfile::tempdir;

    #[test]
    fn round_trips_a_canonical_windows_workspace_root() {
        let temp = tempdir().unwrap();
        std::fs::write(temp.path().join("visible.txt"), "visible").unwrap();
        let created = create_windows_workspace_root(temp.path().to_path_buf()).unwrap();

        let resolved =
            resolve_windows_workspace_root("windows", &created.canonical_path_utf16).unwrap();

        assert_eq!(resolved, temp.path().canonicalize().unwrap());
    }

    #[test]
    fn rejects_a_grant_from_a_different_platform() {
        let temp = tempdir().unwrap();
        let created = create_windows_workspace_root(temp.path().to_path_buf()).unwrap();
        let error =
            resolve_windows_workspace_root("macos", &created.canonical_path_utf16).unwrap_err();
        assert!(error.contains("not created by the Windows"));
    }
}
