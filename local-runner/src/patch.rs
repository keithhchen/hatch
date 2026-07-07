use crate::error::{LocalRunnerError, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HatchPatch {
    Append { text: String },
    Replace { old: String, new: String },
}

impl HatchPatch {
    pub fn parse(input: &str) -> Result<Self> {
        let body = input
            .strip_prefix("HATCH-PATCH v1\n")
            .ok_or_else(|| LocalRunnerError::PatchParse("missing HATCH-PATCH v1 header".into()))?;

        if let Some(text) = body.strip_prefix("append\n---\n") {
            return Ok(Self::Append {
                text: text.to_string(),
            });
        }

        if let Some(replace_body) = body.strip_prefix("replace\n--- old\n") {
            let Some((old, new)) = replace_body.split_once("\n--- new\n") else {
                return Err(LocalRunnerError::PatchParse(
                    "replace patch must contain an --- new delimiter".into(),
                ));
            };

            if old.is_empty() {
                return Err(LocalRunnerError::PatchParse(
                    "replace patch old text cannot be empty".into(),
                ));
            }

            return Ok(Self::Replace {
                old: old.to_string(),
                new: new.to_string(),
            });
        }

        Err(LocalRunnerError::PatchParse(
            "expected append or replace operation".into(),
        ))
    }
}

pub fn apply_text_patch(existing: &str, patch: &HatchPatch) -> Result<String> {
    match patch {
        HatchPatch::Append { text } => {
            let mut next = String::with_capacity(existing.len() + text.len());
            next.push_str(existing);
            next.push_str(text);
            Ok(next)
        }
        HatchPatch::Replace { old, new } => {
            let matches = existing.matches(old).count();
            match matches {
                0 => Err(LocalRunnerError::PatchOldTextNotFound),
                1 => Ok(existing.replacen(old, new, 1)),
                count => Err(LocalRunnerError::PatchAmbiguousReplacement(count)),
            }
        }
    }
}
