use crate::error::{LocalRunnerError, Result};
use std::fs;
use std::path::{Component, Path, PathBuf};

const AUDIT_FILE_NAME: &str = "audit.jsonl";

#[derive(Debug, Clone)]
pub struct Sandbox {
    root: PathBuf,
    read_roots: Vec<PathBuf>,
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
            read_roots: Vec::new(),
        })
    }

    pub fn with_read_roots(mut self, roots: &[PathBuf]) -> Result<Self> {
        for root in roots {
            let canonical = root
                .canonicalize()
                .map_err(|e| LocalRunnerError::io(root, e))?;
            if !canonical.is_dir() {
                return Err(LocalRunnerError::ExpectedDirectory(
                    canonical.display().to_string(),
                ));
            }
            self.read_roots.push(canonical);
        }
        Ok(self)
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
        let input = input.as_ref();
        if input.is_absolute() {
            for root in &self.read_roots {
                if input.starts_with(root) {
                    let canonical = input
                        .canonicalize()
                        .map_err(|e| LocalRunnerError::io(input, e))?;
                    if !canonical.starts_with(root) {
                        return Err(LocalRunnerError::PathEscapesSandbox(
                            input.display().to_string(),
                        ));
                    }
                    return Ok(ResolvedPath {
                        absolute: canonical.clone(),
                        relative: canonical,
                    });
                }
            }
        }
        let relative = self.normalize_tool_path(input, true)?;
        let absolute = self.root.join(&relative);
        let canonical = absolute
            .canonicalize()
            .map_err(|source| LocalRunnerError::io(&absolute, source))?;

        if !canonical.starts_with(&self.root) {
            return Err(LocalRunnerError::PathEscapesSandbox(
                input.display().to_string(),
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
            self.ensure_writable(&canonical)?;
            if self.is_reserved_path(&canonical) {
                return Err(LocalRunnerError::ReservedPath(AUDIT_FILE_NAME.into()));
            }
        } else {
            self.ensure_nearest_existing_ancestor_is_contained(&absolute, input.as_ref())?;
            self.ensure_writable(&absolute)?;
        }

        Ok(ResolvedPath { absolute, relative })
    }

    pub fn to_relative_string(&self, path: &Path) -> String {
        let relative = path.strip_prefix(&self.root).unwrap_or(path);
        path_to_string(relative)
    }

    fn normalize_tool_path(&self, input: &Path, allow_root: bool) -> Result<PathBuf> {
        let input = if input.is_absolute() {
            input
                .strip_prefix(&self.root)
                .map_err(|_| LocalRunnerError::PathEscapesSandbox(input.display().to_string()))?
        } else {
            input
        };
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

    fn ensure_writable(&self, path: &Path) -> Result<()> {
        if self.read_roots.iter().any(|root| path.starts_with(root)) {
            return Err(LocalRunnerError::InvalidPath(
                "the attachment/runtime directory is read-only".into(),
            ));
        }
        Ok(())
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
        self.ensure_writable(&canonical)?;

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
