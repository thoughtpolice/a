// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use super::*;

#[test]
fn a_bare_relative_key_path_uses_the_current_directory() {
    assert_eq!(key_parent(Path::new("mykey")), Path::new("."));
    assert_eq!(key_parent(Path::new("keys/mykey")), Path::new("keys"));
}

#[test]
fn a_directory_is_not_reported_as_a_loose_key_file() {
    let dir = tempfile::tempdir().expect("a scratch directory");
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o755))
        .expect("make the directory visibly too permissive for a key");

    let err = load_or_create_key(dir.path()).expect_err("a directory cannot be a key file");
    let message = format!("{err:#}");
    assert!(
        message.contains("not a regular file"),
        "unhelpful: {message}"
    );
    assert!(
        !message.contains("chmod 600"),
        "a chmod hint is wrong for a directory: {message}",
    );
}

#[test]
fn an_environment_filter_keeps_the_noisy_pacing_target_muted() {
    let (filter, from_env) = log_filter_from(0, Some("burrow=debug"));
    assert!(from_env);
    assert!(
        filter
            .to_string()
            .contains("noq_proto::connection::pacing=error"),
        "built-in directive was lost: {filter}",
    );
}
