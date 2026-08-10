use crate::error::{LocalRunnerError, Result};
use std::fs;
use std::path::{Component, Path, PathBuf};

const AUDIT_FILE_NAME: &str = "audit.jsonl";

#[derive(Debug, Clone)]
pub struct Sandbox {
    root: PathBuf,
}

#[derive(Debug, Clone)]
pub struct ResolvedPath {
    pub absolute: PathBuf,
    pub relative: PathBuf,
}

impl Sandbox {
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        fs::create_dir_all(root).map_err(|source| LocalRunnerError::io(root, source))?;
        let canonical_root = root
            .canonicalize()
            .map_err(|source| LocalRunnerError::io(root, source))?;

        if !canonical_root.is_dir() {
            return Err(LocalRunnerError::ExpectedDirectory(
                canonical_root.display().to_string(),
            ));
        }

        Ok(Self {
            root: canonical_root,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn audit_path(&self) -> PathBuf {
        self.root.join(AUDIT_FILE_NAME)
    }

    pub fn is_reserved_path(&self, path: &Path) -> bool {
        let audit_path = self.audit_path();
        if path == audit_path {
            return true;
        }

        let Ok(canonical) = path.canonicalize() else {
            return false;
        };
        let Ok(canonical_audit) = audit_path.canonicalize() else {
            return false;
        };

        canonical == canonical_audit
    }

    pub fn resolve_existing(&self, input: impl AsRef<Path>) -> Result<ResolvedPath> {
        let relative = self.normalize_tool_path(input.as_ref(), true)?;
        let absolute = self.root.join(&relative);
        let canonical = absolute
            .canonicalize()
            .map_err(|source| LocalRunnerError::io(&absolute, source))?;

        if !canonical.starts_with(&self.root) {
            return Err(LocalRunnerError::PathEscapesSandbox(
                input.as_ref().display().to_string(),
            ));
        }
        if self.is_reserved_path(&canonical) {
            return Err(LocalRunnerError::ReservedPath(AUDIT_FILE_NAME.into()));
        }

        Ok(ResolvedPath { absolute, relative })
    }

    pub fn resolve_candidate(
        &self,
        input: impl AsRef<Path>,
        allow_root: bool,
    ) -> Result<ResolvedPath> {
        let relative = self.normalize_tool_path(input.as_ref(), allow_root)?;
        let absolute = self.root.join(&relative);

        if absolute.exists() {
            let canonical = absolute
                .canonicalize()
                .map_err(|source| LocalRunnerError::io(&absolute, source))?;
            if !canonical.starts_with(&self.root) {
                return Err(LocalRunnerError::PathEscapesSandbox(
                    input.as_ref().display().to_string(),
                ));
            }
            if self.is_reserved_path(&canonical) {
                return Err(LocalRunnerError::ReservedPath(AUDIT_FILE_NAME.into()));
            }
        } else {
            self.ensure_nearest_existing_ancestor_is_contained(&absolute, input.as_ref())?;
        }

        Ok(ResolvedPath { absolute, relative })
    }

    pub fn to_relative_string(&self, path: &Path) -> String {
        let relative = path.strip_prefix(&self.root).unwrap_or(path);
        path_to_string(relative)
    }

    fn normalize_tool_path(&self, input: &Path, allow_root: bool) -> Result<PathBuf> {
        let mut normalized = PathBuf::new();

        for component in input.components() {
            match component {
                Component::CurDir => {}
                Component::Normal(part) => normalized.push(part),
                Component::ParentDir => {
                    if !normalized.pop() {
                        return Err(LocalRunnerError::PathEscapesSandbox(
                            input.display().to_string(),
                        ));
                    }
                }
                Component::RootDir | Component::Prefix(_) => {
                    return Err(LocalRunnerError::AbsolutePath(input.display().to_string()));
                }
            }
        }

        if normalized.as_os_str().is_empty() && !allow_root {
            return Err(LocalRunnerError::InvalidPath(
                "root path is not a valid file target".into(),
            ));
        }

        if normalized == Path::new(AUDIT_FILE_NAME) {
            return Err(LocalRunnerError::ReservedPath(AUDIT_FILE_NAME.into()));
        }

        Ok(normalized)
    }

    fn ensure_nearest_existing_ancestor_is_contained(
        &self,
        absolute: &Path,
        original_input: &Path,
    ) -> Result<()> {
        let mut ancestor = absolute.parent().unwrap_or(&self.root);

        while !ancestor.exists() {
            ancestor = ancestor.parent().ok_or_else(|| {
                LocalRunnerError::PathEscapesSandbox(original_input.display().to_string())
            })?;
        }

        let canonical = ancestor
            .canonicalize()
            .map_err(|source| LocalRunnerError::io(ancestor, source))?;
        if !canonical.starts_with(&self.root) {
            return Err(LocalRunnerError::PathEscapesSandbox(
                original_input.display().to_string(),
            ));
        }

        Ok(())
    }
}

pub fn path_to_string(path: &Path) -> String {
    if path.as_os_str().is_empty() {
        ".".into()
    } else {
        path.to_string_lossy().replace('\\', "/")
    }
}
