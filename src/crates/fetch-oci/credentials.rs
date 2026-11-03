// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Credentials for registries that refuse anonymous pulls, read from the
//! `auths` of a Docker `config.json`.

use std::collections::BTreeMap;
use std::fmt;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

use crate::uri::normalize_registry;

/// A username and password (or access token) for one registry.
#[derive(Clone, PartialEq, Eq)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

impl fmt::Debug for Credentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Credentials")
            .field("username", &self.username)
            .field("password", &"<redacted>")
            .finish()
    }
}

impl Credentials {
    /// The `Authorization` header value presenting these credentials with
    /// HTTP Basic auth.
    pub(crate) fn basic(&self) -> String {
        let pair = format!("{}:{}", self.username, self.password);
        format!("Basic {}", STANDARD.encode(pair))
    }
}

/// Credentials by registry host.
#[derive(Clone, Debug, Default)]
pub struct RegistryCredentials(BTreeMap<String, Credentials>);

impl RegistryCredentials {
    /// Read the `auths` of a Docker `config.json`. Each entry gives its
    /// credentials as `auth` (base64 of `username:password`) or as
    /// `username` and `password`. An entry with neither, as `docker login`
    /// leaves when a credential helper keeps the secret, is skipped; one
    /// with only an `identitytoken` (an OAuth refresh token) is refused,
    /// since nothing here can redeem it.
    pub fn from_docker_config(json: &[u8]) -> Result<Self, String> {
        #[derive(serde::Deserialize)]
        struct Config {
            #[serde(default)]
            auths: BTreeMap<String, Entry>,
        }
        #[derive(serde::Deserialize)]
        struct Entry {
            #[serde(default)]
            auth: Option<String>,
            #[serde(default)]
            username: Option<String>,
            #[serde(default)]
            password: Option<String>,
            #[serde(default)]
            identitytoken: Option<String>,
        }

        let config: Config =
            serde_json::from_slice(json).map_err(|e| format!("invalid Docker config: {e}"))?;
        let mut credentials = BTreeMap::new();
        for (key, entry) in config.auths {
            let found = match (
                entry.auth.filter(|a| !a.is_empty()),
                entry.username,
                entry.password,
            ) {
                (Some(auth), _, _) => {
                    let decoded = STANDARD
                        .decode(auth.trim())
                        .ok()
                        .and_then(|bytes| String::from_utf8(bytes).ok())
                        .ok_or_else(|| format!("{key}: `auth` is not base64 of UTF-8 text"))?;
                    let (username, password) = decoded
                        .split_once(':')
                        .ok_or_else(|| format!("{key}: `auth` is not `username:password`"))?;
                    Some(Credentials {
                        username: username.to_string(),
                        password: password.to_string(),
                    })
                }
                (None, Some(username), Some(password)) => Some(Credentials { username, password }),
                _ if entry.identitytoken.is_some() => {
                    return Err(format!(
                        "{key}: identity tokens are not supported; give a username and password or access token"
                    ));
                }
                _ => None,
            };
            if let Some(found) = found {
                credentials.insert(registry_host(&key), found);
            }
        }
        Ok(Self(credentials))
    }

    /// The credentials for `registry`, a host (with `:port` if it has one)
    /// as [`parse_oci_uri`](crate::parse_oci_uri) gives it.
    pub fn get(&self, registry: &str) -> Option<&Credentials> {
        self.0.get(&normalize_registry(registry))
    }

    /// The registries there are credentials for.
    pub fn registries(&self) -> impl Iterator<Item = &str> {
        self.0.keys().map(String::as_str)
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// The registry host a `config.json` key names. Keys are usually bare
/// hosts, but older clients wrote URLs (Docker Hub's is still
/// `https://index.docker.io/v1/`).
fn registry_host(key: &str) -> String {
    let rest = key.split_once("://").map_or(key, |(_, rest)| rest);
    let host = rest.split('/').next().unwrap_or(rest);
    normalize_registry(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(auths: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({ "auths": auths })).unwrap()
    }

    #[test]
    fn reads_auth_and_username_password_entries() {
        let creds = RegistryCredentials::from_docker_config(&config(serde_json::json!({
            "ghcr.io": { "auth": STANDARD.encode("me:token:with:colons") },
            "registry.example.com:5000": { "username": "u", "password": "p" },
        })))
        .unwrap();
        assert_eq!(
            creds.get("ghcr.io"),
            Some(&Credentials {
                username: "me".into(),
                password: "token:with:colons".into(),
            })
        );
        assert_eq!(
            creds.get("registry.example.com:5000").unwrap().username,
            "u"
        );
        assert_eq!(creds.get("registry.example.com"), None);
    }

    #[test]
    fn docker_hub_keys_name_the_registry_uris_resolve_to() {
        for key in [
            "https://index.docker.io/v1/",
            "docker.io",
            "index.docker.io",
        ] {
            let creds = RegistryCredentials::from_docker_config(&config(serde_json::json!({
                key: { "username": "u", "password": "p" },
            })))
            .unwrap();
            let registry = crate::parse_oci_uri(
                "oci://docker.io/library/alpine@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            )
            .unwrap()
            .registry;
            assert!(creds.get(&registry).is_some(), "{key}");
        }
    }

    #[test]
    fn entries_without_secrets_are_skipped() {
        let creds = RegistryCredentials::from_docker_config(
            br#"{"auths": {"ghcr.io": {}}, "credsStore": "desktop"}"#,
        )
        .unwrap();
        assert!(creds.is_empty());
    }

    #[test]
    fn identity_tokens_and_bad_auth_are_refused() {
        let err = RegistryCredentials::from_docker_config(&config(serde_json::json!({
            "myregistry.azurecr.io": { "identitytoken": "refresh" },
        })))
        .unwrap_err();
        assert!(err.contains("identity tokens"), "{err}");

        let err = RegistryCredentials::from_docker_config(&config(serde_json::json!({
            "ghcr.io": { "auth": STANDARD.encode("no-colon") },
        })))
        .unwrap_err();
        assert!(err.contains("username:password"), "{err}");
    }

    #[test]
    fn debug_hides_the_password() {
        let creds = Credentials {
            username: "me".into(),
            password: "hunter2".into(),
        };
        assert!(!format!("{creds:?}").contains("hunter2"));
        assert_eq!(
            creds.basic(),
            format!("Basic {}", STANDARD.encode("me:hunter2"))
        );
    }
}
