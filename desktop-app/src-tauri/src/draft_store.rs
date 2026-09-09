//! One durable draft per account/conversation; one editing window at a time.
use crate::window_commands::NativeCommandRouter;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::PathBuf};

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    pub text: String,
    pub attachments: Vec<DraftAttachment>,
    #[serde(default)]
    pub text_revision: u64,
    #[serde(default)]
    pub pending: Option<PendingSubmission>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingSubmission {
    pub run_id: String,
    pub client_message_id: String,
    pub text: String,
    pub attachments: Vec<DraftAttachment>,
    pub text_revision: u64,
    pub status: String,
    // None is a read-time legacy boundary, not permission to use current grants.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_snapshot: Option<PendingAccessSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingAccessSnapshot {
    pub workspace_grant_id: String,
    pub display_path: String,
    pub permission_mode: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftAttachment {
    pub context_id: String,
    pub asset_id: String,
    pub display_name: String,
    pub media_type: String,
    pub size: u64,
    pub sha256: String,
    pub is_image: bool,
    pub local_path: String,
    pub host_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenDraft {
    pub lease: String,
    pub draft: Draft,
}

pub struct DraftStore {
    root: PathBuf,
    registry: NativeCommandRouter,
}

fn key(account: &str, conversation: &str) -> Result<String, String> {
    for value in [account, conversation] {
        if value.is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
            return Err("draft_invalid: Invalid account/conversation".into());
        }
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(format!("{account}\0{conversation}").as_bytes())
    ))
}

impl DraftStore {
    pub fn new(root: PathBuf, registry: NativeCommandRouter) -> Self {
        Self { root, registry }
    }

    pub fn open(
        &self,
        account: &str,
        conversation: &str,
        window: &str,
    ) -> Result<OpenDraft, String> {
        let key = key(account, conversation)?;
        self.registry
            .with_session_lease(account, conversation, window, None, |lease| {
                let path = self.root.join(format!("{key}.json"));
                let draft = match fs::read(&path) {
                    Ok(bytes) => serde_json::from_slice::<Draft>(&bytes)
                        .map_err(|e| format!("draft_invalid: {e}"))?,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Draft::default(),
                    Err(e) => return Err(format!("draft_unavailable: {e}")),
                };
                validate(&draft)?;
                Ok(OpenDraft {
                    lease: lease.to_owned(),
                    draft,
                })
            })
    }

    pub fn save(
        &self,
        account: &str,
        conversation: &str,
        window: &str,
        lease: &str,
        draft: Draft,
    ) -> Result<(), String> {
        validate(&draft)?;
        let key = key(account, conversation)?;
        self.registry
            .with_session_lease(account, conversation, window, Some(lease), |_| {
                fs::create_dir_all(&self.root).map_err(|e| format!("draft_unavailable: {e}"))?;
                let path = self.root.join(format!("{key}.json"));
                let temporary = self
                    .root
                    .join(format!("{key}.{}.tmp", uuid::Uuid::new_v4()));
                let result = (|| -> std::io::Result<()> {
                    let mut options = fs::OpenOptions::new();
                    options.create_new(true).write(true);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.mode(0o600);
                    }
                    let mut file = options.open(&temporary)?;
                    file.write_all(&serde_json::to_vec(&draft)?)?;
                    file.sync_all()?;
                    drop(file);
                    crate::desktop_state::replace_file(&temporary, &path)?;
                    #[cfg(unix)]
                    fs::File::open(&self.root)?.sync_all()?;
                    Ok(())
                })();
                if result.is_err() {
                    let _ = fs::remove_file(temporary);
                }
                result.map_err(|e| format!("draft_unavailable: {e}"))
            })
    }

    pub fn release(
        &self,
        account: &str,
        conversation: &str,
        window: &str,
        lease: &str,
    ) -> Result<(), String> {
        // Closing a draft does not release its still-draining conversation.
        self.registry
            .with_session_lease(account, conversation, window, Some(lease), |_| Ok(()))
    }

    pub fn close_window(&self, window: &str) {
        self.registry.clear_window(window);
    }
}

fn validate(draft: &Draft) -> Result<(), String> {
    if let Some(pending) = &draft.pending {
        if let Some(access) = &pending.access_snapshot {
            if access.workspace_grant_id.trim().is_empty()
                || access.workspace_grant_id.len() > 256
                || access.workspace_grant_id.chars().any(char::is_control)
                || access.display_path.len() > 32768
                || !["ask-before-changes", "allow-changes"]
                    .contains(&access.permission_mode.as_str())
            {
                return Err("draft_invalid: Invalid pending execution context".into());
            }
        }
        if pending.run_id.is_empty()
            || pending.run_id.len() > 256
            || pending.client_message_id.is_empty()
            || pending.client_message_id.len() > 256
            || !["prepared", "unknown", "failed"].contains(&pending.status.as_str())
        {
            return Err("draft_invalid: Invalid pending submission".into());
        }
        validate(&Draft {
            text: pending.text.clone(),
            attachments: pending.attachments.clone(),
            ..Draft::default()
        })?;
    }
    if draft.text.len() > 256 * 1024 || draft.attachments.len() > 8 {
        return Err("draft_invalid: Draft exceeds text/attachment limits".into());
    }
    let mut ids = std::collections::HashSet::new();
    for file in &draft.attachments {
        if !crate::attachment_store::valid_id(&file.context_id)
            || file.asset_id != file.context_id
            || !ids.insert(&file.context_id)
            || file.display_name.is_empty()
            || file.display_name.len() > 1024
            || file.local_path.len() > 32768
            || file.host_id.len() > 128
            || file.media_type.len() > 128
            || file.sha256.len() != 64
            || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("draft_invalid: Invalid attachment reference".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_execution_snapshot_has_strict_wire_fields_and_legacy_read_boundary() {
        let legacy = serde_json::json!({
            "runId": "run", "clientMessageId": "message", "text": "send me",
            "attachments": [], "textRevision": 0, "status": "unknown"
        });
        let old: PendingSubmission = serde_json::from_value(legacy.clone()).unwrap();
        assert!(old.access_snapshot.is_none());
        let mut current = legacy;
        current["accessSnapshot"] = serde_json::json!({
            "workspaceGrantId": "grant_original", "displayPath": "/workspace/original",
            "permissionMode": "ask-before-changes"
        });
        let pending: PendingSubmission = serde_json::from_value(current.clone()).unwrap();
        assert_eq!(serde_json::to_value(&pending).unwrap(), current);
        let mut draft = Draft {
            pending: Some(pending),
            ..Draft::default()
        };
        validate(&draft).unwrap();
        draft
            .pending
            .as_mut()
            .unwrap()
            .access_snapshot
            .as_mut()
            .unwrap()
            .permission_mode = "host-fallback".into();
        assert!(validate(&draft).unwrap_err().contains("execution context"));
        current["accessSnapshot"]["authorityOverride"] = serde_json::json!(true);
        assert!(serde_json::from_value::<PendingSubmission>(current).is_err());
    }
    #[test]
    fn pending_execution_snapshot_has_strict_wire_fields_and_legacy_read_boundary() {
        let legacy = serde_json::json!({
            "runId": "run", "clientMessageId": "message", "text": "send me",
            "attachments": [], "textRevision": 0, "status": "unknown"
        });
        let old: PendingSubmission = serde_json::from_value(legacy.clone()).unwrap();
        assert!(old.access_snapshot.is_none());
        let mut current = legacy;
        current["accessSnapshot"] = serde_json::json!({
            "workspaceGrantId": "grant_original", "displayPath": "/workspace/original",
            "permissionMode": "ask-before-changes"
        });
        let pending: PendingSubmission = serde_json::from_value(current.clone()).unwrap();
        assert_eq!(serde_json::to_value(&pending).unwrap(), current);
        let mut draft = Draft {
            pending: Some(pending),
            ..Draft::default()
        };
        validate(&draft).unwrap();
        draft
            .pending
            .as_mut()
            .unwrap()
            .access_snapshot
            .as_mut()
            .unwrap()
            .permission_mode = "host-fallback".into();
        assert!(validate(&draft).unwrap_err().contains("execution context"));
        current["accessSnapshot"]["authorityOverride"] = serde_json::json!(true);
        assert!(serde_json::from_value::<PendingSubmission>(current).is_err());
    }
    #[test]
    fn unknown_submission_and_later_edits_survive_store_restart() {
        let temp = tempfile::tempdir().unwrap();
        let store = DraftStore::new(temp.path().into(), NativeCommandRouter::default());
        store
            .registry
            .claim_session("account", "conversation", "agent", "main")
            .unwrap();
        let opened = store.open("account", "conversation", "main").unwrap();
        let file = DraftAttachment {
            context_id: format!("drop_{}", "a".repeat(32)),
            asset_id: format!("drop_{}", "a".repeat(32)),
            display_name: "page.png".into(),
            media_type: "image/png".into(),
            size: 42,
            sha256: "b".repeat(64),
            is_image: true,
            local_path: "/attachments/page.png".into(),
            host_id: "host".into(),
        };
        let draft = Draft {
            text: "newer edit".into(),
            text_revision: 12,
            attachments: vec![file.clone()],
            pending: Some(PendingSubmission {
                run_id: "stable-run".into(),
                client_message_id: "stable-message".into(),
                text: "submitted text".into(),
                text_revision: 10,
                attachments: vec![file],
                status: "unknown".into(),
                access_snapshot: Some(PendingAccessSnapshot {
                    workspace_grant_id: "original-grant".into(),
                    display_path: "/workspace/original".into(),
                    permission_mode: "ask-before-changes".into(),
                }),
            }),
        };
        store
            .save(
                "account",
                "conversation",
                "main",
                &opened.lease,
                draft.clone(),
            )
            .unwrap();
        drop(store);
        let restarted = DraftStore::new(temp.path().into(), NativeCommandRouter::default());
        restarted
            .registry
            .claim_session("account", "conversation", "agent", "new-window")
            .unwrap();
        assert_eq!(
            restarted
                .open("account", "conversation", "new-window")
                .unwrap()
                .draft,
            draft
        );
        restarted.close_window("new-window");
        restarted
            .registry
            .claim_session("other-account", "conversation", "agent", "main")
            .unwrap();
        assert!(restarted
            .open("other-account", "conversation", "main")
            .unwrap()
            .draft
            .pending
            .is_none());
    }

    #[test]
    fn conversation_and_account_drafts_survive_restart_independently() {
        let temp = tempfile::tempdir().unwrap();
        let store = DraftStore::new(temp.path().into(), NativeCommandRouter::default());
        for (account, conversation, text) in [
            ("a", "one", "first"),
            ("a", "two", "second"),
            ("b", "one", "other account"),
        ] {
            store.close_window("main");
            store
                .registry
                .claim_session(account, conversation, "agent", "main")
                .unwrap();
            let opened = store.open(account, conversation, "main").unwrap();
            store
                .save(
                    account,
                    conversation,
                    "main",
                    &opened.lease,
                    Draft {
                        text: text.into(),
                        attachments: vec![],
                        ..Draft::default()
                    },
                )
                .unwrap();
        }
        let restarted = DraftStore::new(temp.path().into(), NativeCommandRouter::default());
        restarted
            .registry
            .claim_session("a", "one", "agent", "main")
            .unwrap();
        restarted
            .registry
            .claim_session("a", "two", "agent", "main")
            .unwrap();
        assert_eq!(
            restarted.open("a", "one", "main").unwrap().draft.text,
            "first"
        );
        assert_eq!(
            restarted.open("a", "two", "main").unwrap().draft.text,
            "second"
        );
        restarted.close_window("main");
        restarted
            .registry
            .claim_session("b", "one", "agent", "main")
            .unwrap();
        assert_eq!(
            restarted.open("b", "one", "main").unwrap().draft.text,
            "other account"
        );
    }
    #[test]
    fn only_one_window_writes_and_old_lease_cannot_release_new_owner() {
        let temp = tempfile::tempdir().unwrap();
        let store = DraftStore::new(temp.path().into(), NativeCommandRouter::default());
        store
            .registry
            .claim_session("a", "c", "agent", "one")
            .unwrap();
        let first = store.open("a", "c", "one").unwrap();
        assert!(store
            .open("a", "c", "two")
            .unwrap_err()
            .contains("draft_lease_lost"));
        assert!(store
            .save("a", "c", "two", &first.lease, Draft::default())
            .is_err());
        store.close_window("one");
        store
            .registry
            .claim_session("a", "c", "agent", "two")
            .unwrap();
        let second = store.open("a", "c", "two").unwrap();
        assert!(store.release("a", "c", "one", &first.lease).is_err());
        store
            .registry
            .release_session("a", "c", "one", &first.lease)
            .unwrap();
        store
            .save(
                "a",
                "c",
                "two",
                &second.lease,
                Draft {
                    text: "new".into(),
                    attachments: vec![],
                    ..Draft::default()
                },
            )
            .unwrap();
        assert!(store
            .save("a", "c", "one", &first.lease, Draft::default())
            .is_err());
    }
    #[test]
    fn invalid_json_is_not_silently_replaced_with_empty_draft() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(
            temp.path().join(format!("{}.json", key("a", "c").unwrap())),
            "broken",
        )
        .unwrap();
        let store = DraftStore::new(temp.path().into(), NativeCommandRouter::default());
        store
            .registry
            .claim_session("a", "c", "agent", "main")
            .unwrap();
        assert!(store
            .open("a", "c", "main")
            .unwrap_err()
            .contains("draft_invalid"));
    }
}
