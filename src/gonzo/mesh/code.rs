// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Join codes: six words a daemon makes up once and keeps, which a worker
//! anywhere types to join it, as `gonzo-worker --join acid-bunny-…`.
//!
//! A code is a [`Cluster`]: the daemon announces itself on the mainline DHT
//! under it, and workers find the daemon there and join with the key it
//! derives. What DHT nodes see is derived from the code, so the code has to
//! be impossible to find by trying codes against it:
//!
//! - It is random, six of the 1296 words of EFF's short wordlist: 62 bits.
//! - The topic and the join key come from it through Argon2id with RFC
//!   9106's second recommended parameters (64 MiB, three passes), which
//!   make each guess cost about as much as a worker spends once at start.
//!   Trying every code would take hundreds of millions of GPU-years.
//!
//! Magic Wormhole makes do with shorter codes because each is used once
//! and a password-authenticated key exchange allows a single guess; a join
//! code is used for as long as the daemon keeps it, by every worker, so it
//! is the code itself that has to be strong.

use std::fmt;
use std::io;
use std::path::Path;
use std::str::FromStr;

use iroh_rendezvous::Topic;

use crate::cluster::Cluster;
use crate::keys::{JoinKey, keep};
use crate::words::WORDS;

/// See the module documentation.
#[derive(Clone, PartialEq, Eq)]
pub struct JoinCode([u16; JoinCode::WORDS]);

impl JoinCode {
    /// Words in a code.
    pub const WORDS: usize = 6;

    pub fn generate() -> Self {
        // Uniform over the list: of every 65536 values a u16 takes, the
        // first 50 * 1296 = 64800 map onto it evenly.
        let limit = (u16::MAX as usize + 1) / WORDS.len() * WORDS.len();
        let mut words = [0; Self::WORDS];
        let mut filled = 0;
        while filled < Self::WORDS {
            let random = iroh::SecretKey::generate().to_bytes();
            for pair in random.chunks_exact(2) {
                let value = u16::from_le_bytes([pair[0], pair[1]]) as usize;
                if value < limit && filled < Self::WORDS {
                    words[filled] = (value % WORDS.len()) as u16;
                    filled += 1;
                }
            }
        }
        Self(words)
    }

    /// The code kept at `path`, or a new one written there, readable by
    /// the owner alone.
    pub fn load_or_create(path: &Path) -> io::Result<Self> {
        keep(path, || Self::generate().to_string())?
            .parse()
            .map_err(|e| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("{}: {e}", path.display()),
                )
            })
    }

    /// The cluster the code names. This is the slow part (a fraction of a
    /// second, and 64 MiB), so run it off the async runtime's threads.
    pub fn cluster(&self) -> Cluster {
        let params = argon2::Params::new(64 * 1024, 3, 4, Some(64)).expect("valid parameters");
        let argon2 =
            argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
        let mut derived = [0; 64];
        argon2
            .hash_password_into(
                self.to_string().as_bytes(),
                b"gonzo join code v1",
                &mut derived,
            )
            .expect("an output of a valid length");
        let (topic, key) = derived.split_at(32);
        Cluster::new(
            Topic::new(topic),
            JoinKey(key.try_into().expect("32 bytes")),
            self.hint(),
        )
    }

    /// Enough of the code to tell which it is in a log, and too little to
    /// join with: its first word.
    pub fn hint(&self) -> String {
        format!("{}-…", WORDS[self.0[0] as usize])
    }
}

impl fmt::Display for JoinCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (i, &word) in self.0.iter().enumerate() {
            if i > 0 {
                f.write_str("-")?;
            }
            f.write_str(WORDS[word as usize])?;
        }
        Ok(())
    }
}

/// Codes are credentials; a debug print shows the [`hint`](JoinCode::hint)
/// alone.
impl fmt::Debug for JoinCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "JoinCode({})", self.hint())
    }
}

/// A string that is not a join code.
#[derive(Debug, thiserror::Error)]
pub enum ParseCodeError {
    #[error("a join code has {} words, not {given}", JoinCode::WORDS)]
    Length { given: usize },
    #[error("{0:?} is not a word join codes use")]
    Word(String),
}

impl FromStr for JoinCode {
    type Err = ParseCodeError;

    /// Words joined by `-` or spaces, in any case.
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let words: Vec<String> = s
            .split(|c: char| c == '-' || c.is_whitespace())
            .filter(|word| !word.is_empty())
            .map(str::to_ascii_lowercase)
            .collect();
        if words.len() != Self::WORDS {
            return Err(ParseCodeError::Length { given: words.len() });
        }
        let mut code = [0; Self::WORDS];
        for (slot, word) in code.iter_mut().zip(words) {
            *slot = WORDS
                .iter()
                .position(|w| *w == word)
                .ok_or(ParseCodeError::Word(word))? as u16;
        }
        Ok(Self(code))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_round_trips_in_any_case_and_spacing() {
        let code = JoinCode::generate();
        let printed = code.to_string();
        assert_eq!(printed.split('-').count(), JoinCode::WORDS);
        assert_eq!(printed.parse::<JoinCode>().unwrap(), code);
        let shouted = printed.to_uppercase().replace('-', "  ");
        assert_eq!(shouted.parse::<JoinCode>().unwrap(), code);
        assert!(!format!("{code:?}").contains(&printed));
    }

    #[test]
    fn only_six_known_words_are_a_code() {
        assert!(matches!(
            "acid-acorn-acre".parse::<JoinCode>(),
            Err(ParseCodeError::Length { given: 3 })
        ));
        assert!(matches!(
            "acid-acorn-acre-acts-afar-xyzzy".parse::<JoinCode>(),
            Err(ParseCodeError::Word(w)) if w == "xyzzy"
        ));
        assert!("acid-acorn-acre-acts-afar-yoyo".parse::<JoinCode>().is_ok());
    }

    #[test]
    fn the_list_has_distinct_words_without_separators() {
        let distinct: std::collections::HashSet<_> = WORDS.iter().collect();
        assert_eq!(distinct.len(), WORDS.len());
        assert!(
            WORDS
                .iter()
                .all(|w| w.bytes().all(|b| b.is_ascii_lowercase()))
        );
    }

    #[test]
    fn generated_codes_differ() {
        assert_ne!(JoinCode::generate(), JoinCode::generate());
    }

    #[test]
    fn a_code_derives_the_same_cluster_everywhere() {
        let code: JoinCode = "acid-acorn-acre-acts-afar-affix".parse().unwrap();
        let other: JoinCode = "acid-acorn-acre-acts-afar-aged".parse().unwrap();
        assert_eq!(code.cluster().key(), code.cluster().key());
        assert_ne!(code.cluster().key(), other.cluster().key());
    }

    #[test]
    fn a_code_is_kept_where_it_was_made() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mesh/join-code");
        let code = JoinCode::load_or_create(&path).unwrap();
        assert_eq!(JoinCode::load_or_create(&path).unwrap(), code);
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
