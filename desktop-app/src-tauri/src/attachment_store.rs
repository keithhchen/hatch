//! Durable local attachment copies. This directory contains no credentials.
//! Removing a composer chip does not delete a file: committed history may refer to it.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub host_id: String,
    pub path: PathBuf,
    pub display_name: String,
    pub media_type: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone)]
pub struct AttachmentStore {
    root: PathBuf,
    host_id: String,
}

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn valid_id(id: &str) -> bool {
    id.len() == 37 && id.starts_with("drop_") && id[5..].bytes().all(|b| b.is_ascii_hexdigit())
}

impl AttachmentStore {
    pub fn open(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&root).map_err(error)?;
        let root = root.canonicalize().map_err(error)?;
        let host_path = root.join("host-id");
        let read_host = || -> Result<String, std::io::Error> {
            if !fs::symlink_metadata(&host_path)?.file_type().is_file() {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Invalid host identity file",
                ));
            }
            fs::read_to_string(&host_path)
        };
        let host_id = match read_host() {
            Ok(id) => id,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let id = uuid::Uuid::new_v4().to_string();
                // Publish only a complete, synced identity; never overwrite an
                // identity concurrently established by another native process.
                let mut file = tempfile::NamedTempFile::new_in(&root).map_err(error)?;
                file.write_all(id.as_bytes()).map_err(error)?;
                file.as_file().sync_all().map_err(error)?;
                match file.persist_noclobber(&host_path) {
                    Ok(_) => id,
                    Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                        read_host().map_err(error)?
                    }
                    Err(e) => return Err(error(e)),
                }
            }
            Err(e) => return Err(error(e)),
        };
        uuid::Uuid::parse_str(&host_id).map_err(error)?;
        #[cfg(unix)]
        fs::File::open(&root)
            .and_then(|file| file.sync_all())
            .map_err(error)?;
        Ok(Self { root, host_id })
    }

    pub fn import(
        &self,
        source: &Path,
        media_type: &str,
        limit: u64,
    ) -> Result<Attachment, String> {
        if !fs::symlink_metadata(source)
            .map_err(error)?
            .file_type()
            .is_file()
        {
            return Err("attachment_invalid: Only regular files can be attached".into());
        }
        let name = source
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| {
                !n.is_empty() && n.chars().count() <= 256 && !n.chars().any(char::is_control)
            })
            .ok_or("attachment_invalid: Invalid filename")?;
        let input = fs::File::open(source).map_err(error)?;
        if !input.metadata().map_err(error)?.is_file() {
            return Err("attachment_invalid: Not a file".into());
        }
        self.import_reader(name, media_type, input, limit)
    }

    pub fn import_reader(
        &self,
        name: &str,
        media_type: &str,
        mut input: impl Read,
        limit: u64,
    ) -> Result<Attachment, String> {
        if name.is_empty()
            || name == "."
            || name == ".."
            || name.chars().count() > 256
            || name
                .chars()
                .any(|c| c.is_control() || c == '/' || c == '\\' || c == ':')
            || media_type.len() > 128
            || !media_type.contains('/')
            || !media_type.is_ascii()
            || media_type.chars().any(char::is_whitespace)
        {
            return Err("attachment_invalid: Invalid filename or media type".into());
        }
        let id = format!("drop_{}", uuid::Uuid::new_v4().simple());
        let dir = self.root.join(&id);
        fs::create_dir(&dir).map_err(error)?;
        let result = (|| {
            let files = dir.join("file");
            fs::create_dir(&files).map_err(error)?;
            let path = files.join(name);
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .map_err(error)?;
            let mut hasher = Sha256::new();
            let mut size = 0u64;
            let mut buffer = [0u8; 65536];
            loop {
                let count = input.read(&mut buffer).map_err(error)?;
                if count == 0 {
                    break;
                }
                size += count as u64;
                if size > limit {
                    return Err(
                        "native_drop_context_too_large: Attachment exceeds the file size limit"
                            .into(),
                    );
                }
                hasher.update(&buffer[..count]);
                output.write_all(&buffer[..count]).map_err(error)?;
            }
            output.sync_all().map_err(error)?;
            let attachment = Attachment {
                id,
                host_id: self.host_id.clone(),
                path,
                display_name: name.to_owned(),
                media_type: media_type.to_owned(),
                size,
                sha256: format!("{:x}", hasher.finalize()),
            };
            let mut metadata = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(dir.join(".attachment.json"))
                .map_err(error)?;
            metadata
                .write_all(&serde_json::to_vec(&attachment).map_err(error)?)
                .map_err(error)?;
            metadata.sync_all().map_err(error)?;
            #[cfg(unix)]
            {
                fs::File::open(&files)
                    .and_then(|f| f.sync_all())
                    .map_err(error)?;
                fs::File::open(&dir)
                    .and_then(|f| f.sync_all())
                    .map_err(error)?;
                fs::File::open(&self.root)
                    .and_then(|f| f.sync_all())
                    .map_err(error)?;
            }
            Ok(attachment)
        })();
        // This exact fresh UUID directory has not been returned to any caller.
        if result.is_err() {
            let _ = fs::remove_dir_all(&dir);
        }
        result
    }

    pub fn get(&self, id: &str) -> Result<Attachment, String> {
        if !valid_id(id) {
            return Err("attachment_invalid: Invalid attachment ID".into());
        }
        let dir = self.root.join(id);
        if fs::symlink_metadata(&dir)
            .map_err(error)?
            .file_type()
            .is_symlink()
        {
            return Err("attachment_invalid: Symlink directory".into());
        }
        let metadata_path = dir.join(".attachment.json");
        if !fs::symlink_metadata(&metadata_path)
            .map_err(error)?
            .file_type()
            .is_file()
        {
            return Err("attachment_invalid: Invalid metadata file".into());
        }
        let attachment: Attachment =
            serde_json::from_slice(&fs::read(metadata_path).map_err(error)?).map_err(error)?;
        let files = dir.join("file");
        if fs::symlink_metadata(&files)
            .map_err(error)?
            .file_type()
            .is_symlink()
        {
            return Err("attachment_invalid: Symlink file directory".into());
        }
        if attachment.id != id
            || attachment.host_id != self.host_id
            || Path::new(&attachment.display_name).components().count() != 1
            || attachment.path != files.join(&attachment.display_name)
            || !fs::symlink_metadata(&attachment.path)
                .map_err(error)?
                .file_type()
                .is_file()
            || !attachment
                .path
                .canonicalize()
                .map_err(error)?
                .starts_with(&dir)
        {
            return Err("attachment_invalid: Attachment escaped its directory".into());
        }
        Ok(attachment)
    }

    pub fn verified_reference(
        &self,
        id: &str,
        host_id: &str,
        sha256: &str,
    ) -> Result<Attachment, String> {
        if host_id != self.host_id {
            return Err("attachment_host_unavailable: Attachment belongs to another host".into());
        }
        let attachment = self.get(id)?;
        if attachment.sha256 != sha256 {
            return Err("attachment_changed: Saved reference does not match attachment".into());
        }
        let mut source = fs::File::open(&attachment.path).map_err(error)?;
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 65536];
        let mut size = 0u64;
        loop {
            let count = source.read(&mut buffer).map_err(error)?;
            if count == 0 {
                break;
            }
            size += count as u64;
            if size > attachment.size {
                return Err("attachment_changed: File size changed".into());
            }
            digest.update(&buffer[..count]);
        }
        if size != attachment.size || format!("{:x}", digest.finalize()) != sha256 {
            return Err("attachment_changed: File content changed".into());
        }
        Ok(attachment)
    }

    /// Destination is supplied only by the native save dialog, not a tool call.
    pub fn export_reference(
        &self,
        id: &str,
        host_id: &str,
        sha256: &str,
        destination: &Path,
    ) -> Result<(), String> {
        let attachment = self.verified_reference(id, host_id, sha256)?;
        let parent = destination
            .parent()
            .ok_or("attachment_save_failed: Invalid destination")?
            .canonicalize()
            .map_err(error)?;
        if parent.starts_with(&self.root) {
            return Err("attachment_save_failed: Cannot overwrite managed attachments".into());
        }
        let destination = parent.join(
            destination
                .file_name()
                .ok_or("attachment_save_failed: Missing filename")?,
        );
        match fs::symlink_metadata(&destination) {
            Ok(metadata) if !metadata.file_type().is_file() => {
                return Err("attachment_save_failed: Destination must be a regular file".into())
            }
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(error(e)),
            _ => {}
        }
        let mut source = fs::File::open(&attachment.path).map_err(error)?;
        let mut staged = tempfile::NamedTempFile::new_in(&parent).map_err(error)?;
        let mut digest = Sha256::new();
        let mut buffer = [0u8; 65536];
        let mut size = 0u64;
        loop {
            let count = source.read(&mut buffer).map_err(error)?;
            if count == 0 {
                break;
            }
            size += count as u64;
            if size > attachment.size {
                return Err("attachment_changed: File size changed".into());
            }
            digest.update(&buffer[..count]);
            staged.write_all(&buffer[..count]).map_err(error)?;
        }
        if size != attachment.size || format!("{:x}", digest.finalize()) != sha256 {
            return Err("attachment_changed: File content changed".into());
        }
        staged.as_file().sync_all().map_err(error)?;
        staged.persist(&destination).map_err(error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_open_publishes_one_complete_host_identity() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("attachments");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let root = root.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    AttachmentStore::open(root).unwrap().host_id
                })
            })
            .collect();
        let ids: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert!(ids.iter().all(|id| id == &ids[0]));
        assert_eq!(fs::read_to_string(root.join("host-id")).unwrap(), ids[0]);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        // Corruption must be visible, not silently assign a new host to old files.
        fs::write(root.join("host-id"), "incomplete").unwrap();
        assert!(AttachmentStore::open(root.clone()).is_err());
        assert_eq!(
            fs::read_to_string(root.join("host-id")).unwrap(),
            "incomplete"
        );
    }
    #[test]
    fn export_preserves_managed_source_and_checks_before_replacing_destination() {
        let temp = tempfile::tempdir().unwrap();
        let store = AttachmentStore::open(temp.path().join("attachments")).unwrap();
        let file = store
            .import_reader(
                "document.pdf",
                "application/pdf",
                b"original".as_slice(),
                100,
            )
            .unwrap();
        let target = temp.path().join("saved.pdf");
        fs::write(&target, b"previous").unwrap();
        assert!(store
            .export_reference(&file.id, &file.host_id, "wrong", &target)
            .is_err());
        assert_eq!(fs::read(&target).unwrap(), b"previous");
        assert!(store
            .export_reference(&file.id, &file.host_id, &file.sha256, &file.path)
            .is_err());
        store
            .export_reference(&file.id, &file.host_id, &file.sha256, &target)
            .unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"original");
        assert_eq!(fs::read(&file.path).unwrap(), b"original");
        fs::write(&file.path, b"tampered").unwrap();
        assert!(store
            .export_reference(&file.id, &file.host_id, &file.sha256, &target)
            .is_err());
        assert_eq!(fs::read(&target).unwrap(), b"original");
    }
    #[test]
    fn reference_access_checks_host_digest_and_actual_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let store = AttachmentStore::open(temp.path().join("attachments")).unwrap();
        let file = store
            .import_reader(
                "document.pdf",
                "application/pdf",
                b"original".as_slice(),
                100,
            )
            .unwrap();
        assert!(store
            .verified_reference(&file.id, &file.host_id, &file.sha256)
            .is_ok());
        assert!(store
            .verified_reference(&file.id, "other-host", &file.sha256)
            .unwrap_err()
            .contains("host_unavailable"));
        assert!(store
            .verified_reference(&file.id, &file.host_id, "wrong")
            .is_err());
        fs::write(&file.path, b"modified").unwrap();
        assert!(store
            .verified_reference(&file.id, &file.host_id, &file.sha256)
            .unwrap_err()
            .contains("changed"));
    }
    #[test]
    fn clipboard_bytes_use_the_same_durable_copy_and_cannot_choose_a_path() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("attachments");
        let store = AttachmentStore::open(root.clone()).unwrap();
        let file = store
            .import_reader("pasted.png", "image/png", b"image bytes".as_slice(), 100)
            .unwrap();
        assert_eq!(fs::read(&file.path).unwrap(), b"image bytes");
        let restarted = AttachmentStore::open(root).unwrap();
        assert_eq!(restarted.get(&file.id).unwrap().sha256, file.sha256);
        for name in ["../state.json", "..", "x/y", "x\\y", "C:state.json"] {
            assert!(store
                .import_reader(name, "text/plain", b"x".as_slice(), 100)
                .is_err());
        }
    }
    #[test]
    fn copies_survive_original_removal_and_store_restart() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("attachments");
        let source = temp.path().join("notes.txt");
        fs::write(&source, b"original").unwrap();
        let store = AttachmentStore::open(root.clone()).unwrap();
        let first = store.import(&source, "text/plain", 100).unwrap();
        let second = store.import(&source, "text/plain", 100).unwrap();
        assert_ne!(first.path, second.path);
        fs::remove_file(source).unwrap();
        let reopened = AttachmentStore::open(root).unwrap();
        let restored = reopened.get(&first.id).unwrap();
        assert_eq!(restored.host_id, first.host_id);
        assert_eq!(fs::read(restored.path).unwrap(), b"original");
        assert!(reopened.get("drop_../../state.json").is_err());
    }
    #[test]
    fn failed_import_leaves_no_attachment() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("attachments");
        let store = AttachmentStore::open(root.clone()).unwrap();
        let source = temp.path().join("large.bin");
        fs::write(&source, b"1234").unwrap();
        assert!(store
            .import(&source, "application/octet-stream", 3)
            .is_err());
        assert_eq!(fs::read_dir(root).unwrap().count(), 1); // host-id only
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_at_import_and_read() {
        let temp = tempfile::tempdir().unwrap();
        let store = AttachmentStore::open(temp.path().join("attachments")).unwrap();
        let source = temp.path().join("source");
        fs::write(&source, b"x").unwrap();
        let link = temp.path().join("link");
        std::os::unix::fs::symlink(&source, &link).unwrap();
        assert!(store.import(&link, "text/plain", 10).is_err());
        let attachment = store.import(&source, "text/plain", 10).unwrap();
        fs::remove_file(&attachment.path).unwrap();
        std::os::unix::fs::symlink(&source, &attachment.path).unwrap();
        assert!(store.get(&attachment.id).is_err());
    }
}
