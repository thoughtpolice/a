// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The keys a daemon and its workers keep: each one's iroh identity, and
//! the join key that lets a worker in.

use std::fmt;
use std::io::{self, Write as _};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::Path;
use std::str::FromStr;

use iroh::SecretKey;

/// The secret key at `path`, or a new one written there. The key is an
/// endpoint's identity, so it is kept: a daemon whose ID changed would
/// strand every worker that knew it.
pub fn load_or_create_identity(path: &Path) -> io::Result<SecretKey> {
    let bytes = load_or_create(path, || SecretKey::generate().to_bytes())?;
    Ok(SecretKey::from_bytes(&bytes))
}

/// The secret a worker proves it knows to join a daemon, and the daemon
/// proves back. A ticket carries a random one; a cluster's is derived from
/// its name, so that everyone who knows the name has it.
#[derive(Clone, PartialEq, Eq)]
pub struct JoinKey(pub(crate) [u8; 32]);

impl JoinKey {
    pub fn generate() -> Self {
        Self(SecretKey::generate().to_bytes())
    }

    /// The key every member of the cluster called `name` shares.
    pub fn for_cluster(name: &str) -> Self {
        Self(blake3::derive_key(
            "gonzo cluster join key v1",
            name.as_bytes(),
        ))
    }

    /// The key at `path`, or a new one written there.
    pub fn load_or_create(path: &Path) -> io::Result<Self> {
        Ok(Self(load_or_create(path, || Self::generate().0)?))
    }
}

impl fmt::Debug for JoinKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("JoinKey(..)")
    }
}

impl fmt::Display for JoinKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&hex::encode(self.0))
    }
}

impl FromStr for JoinKey {
    type Err = hex::FromHexError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let mut key = [0; 32];
        hex::decode_to_slice(s.trim(), &mut key)?;
        Ok(Self(key))
    }
}

/// 32 bytes kept in hex at `path`, readable by the owner alone, made with
/// `new` the first time.
fn load_or_create(path: &Path, new: impl FnOnce() -> [u8; 32]) -> io::Result<[u8; 32]> {
    match read(path) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        read => return read,
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Written whole beside it, then linked into place, which fails if
    // someone else got there first: theirs it is, then.
    let partial = path.with_extension(format!("partial.{}", std::process::id()));
    let mut file = std::fs::File::options()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&partial)?;
    writeln!(file, "{}", hex::encode(new()))?;
    file.sync_all()?;
    let linked = std::fs::hard_link(&partial, path);
    std::fs::remove_file(&partial)?;
    match linked {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    read(path)
}

fn read(path: &Path) -> io::Result<[u8; 32]> {
    let text = std::fs::read_to_string(path)?;
    let mut bytes = [0; 32];
    hex::decode_to_slice(text.trim(), &mut bytes).map_err(|e| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{}: {e}", path.display()),
        )
    })?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_kept_where_they_were_made() {
        let dir = tempfile::tempdir().unwrap();
        let identity = load_or_create_identity(&dir.path().join("identity")).unwrap();
        let again = load_or_create_identity(&dir.path().join("identity")).unwrap();
        assert_eq!(identity.public(), again.public());

        let join = JoinKey::load_or_create(&dir.path().join("join")).unwrap();
        assert_eq!(
            JoinKey::load_or_create(&dir.path().join("join")).unwrap(),
            join
        );
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(dir.path().join("join"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_cluster_key_follows_from_the_name() {
        assert_eq!(JoinKey::for_cluster("lab"), JoinKey::for_cluster("lab"));
        assert_ne!(JoinKey::for_cluster("lab"), JoinKey::for_cluster("lab2"));
        let key = JoinKey::generate();
        assert_eq!(key.to_string().parse::<JoinKey>().unwrap(), key);
    }
}
