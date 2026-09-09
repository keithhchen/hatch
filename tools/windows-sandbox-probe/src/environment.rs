// A complete environment block, never an overlay on the host environment.
const ALLOWED: &[&str] = &[
    "SYSTEMROOT",
    "PATH",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PYTHONNOUSERSITE",
    "PYTHONDONTWRITEBYTECODE",
    "PYTHONPATH",
    "NODE_PATH",
];

pub fn block(mut values: Vec<(&str, String)>) -> Result<Vec<u16>, String> {
    let mut keys = std::collections::HashSet::new();
    for (key, value) in &values {
        let key = key.to_ascii_uppercase();
        if !ALLOWED.contains(&key.as_str()) || !keys.insert(key) || value.contains('\0') {
            return Err("Invalid or duplicate environment field; no host fallback".into());
        }
    }
    values.sort_by_key(|(key, _)| key.to_ascii_uppercase());
    let mut result = Vec::new();
    for (key, value) in values {
        result.extend(format!("{key}={value}").encode_utf16());
        result.push(0);
    }
    if result.is_empty() {
        result.push(0);
    }
    result.push(0);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_credentials_injection_and_case_insensitive_duplicates() {
        for key in [
            "GITHUB_TOKEN",
            "AWS_SECRET_ACCESS_KEY",
            "HATCH_PROBE_PASSWORD",
            "NODE_OPTIONS",
            "PSModulePath",
        ] {
            assert!(block(vec![(key, "synthetic".into())]).is_err());
        }
        assert!(block(vec![("PATH", "a".into()), ("Path", "b".into())]).is_err());
        assert!(block(vec![("PATH", "a\0GITHUB_TOKEN=synthetic".into())]).is_err());
    }
    #[test]
    fn block_is_sorted_double_terminated_and_contains_only_supplied_values() {
        let b = block(vec![
            ("TEMP", "C:\\中文 test".into()),
            ("PATH", "C:\\Windows\\System32".into()),
        ])
        .unwrap();
        assert_eq!(
            String::from_utf16(&b).unwrap(),
            "PATH=C:\\Windows\\System32\0TEMP=C:\\中文 test\0\0"
        );
        assert_eq!(block(vec![]).unwrap(), vec![0, 0]);
    }
}
