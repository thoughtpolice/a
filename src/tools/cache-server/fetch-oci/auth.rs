// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Registry auth: parse `WWW-Authenticate` challenges and fetch bearer tokens.

use crate::OciFetchError;

/// Parameters extracted from a `WWW-Authenticate: Bearer …` header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BearerChallenge {
    pub realm: String,
    pub service: Option<String>,
    pub scope: Option<String>,
}

/// Returns `true` if the header starts with `Basic` (case-insensitive).
pub fn is_basic_challenge(header: &str) -> bool {
    header
        .trim_start()
        .to_ascii_lowercase()
        .starts_with("basic")
}

/// Parse a `WWW-Authenticate: Bearer realm="…", service="…", scope="…"` header.
pub fn parse_bearer_challenge(header: &str) -> Result<BearerChallenge, OciFetchError> {
    let trimmed = header.trim_start();
    let body = trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))
        .ok_or_else(|| {
            OciFetchError::AuthChallengeMalformed(format!("not a Bearer challenge: {header}"))
        })?;

    let mut realm = None;
    let mut service = None;
    let mut scope = None;

    for raw in split_params(body) {
        let (k, v) = raw.split_once('=').ok_or_else(|| {
            OciFetchError::AuthChallengeMalformed(format!("malformed challenge param: {raw}"))
        })?;
        let v = v.trim().trim_matches('"');
        match k.trim().to_ascii_lowercase().as_str() {
            "realm" => realm = Some(v.to_string()),
            "service" => service = Some(v.to_string()),
            "scope" => scope = Some(v.to_string()),
            _ => {}
        }
    }

    let realm = realm.ok_or_else(|| {
        OciFetchError::AuthChallengeMalformed(format!("Bearer challenge missing realm: {header}"))
    })?;
    Ok(BearerChallenge {
        realm,
        service,
        scope,
    })
}

/// Split a comma-separated parameter string, respecting double-quoted values.
fn split_params(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut in_quotes = false;
    let bytes = s.as_bytes();
    for (i, b) in bytes.iter().enumerate() {
        match *b {
            b'"' => in_quotes = !in_quotes,
            b',' if !in_quotes => {
                out.push(s[start..i].trim());
                start = i + 1;
            }
            _ => {}
        }
    }
    let tail = s[start..].trim();
    if !tail.is_empty() {
        out.push(tail);
    }
    out
}

/// Build the token endpoint URL from a parsed challenge.
///
/// Appends `service` and `scope` as query parameters when present. No other
/// encoding is performed; OCI scopes like `repository:foo/bar:pull` are
/// URL-safe under RFC 3986 and accepted by every real registry in this form.
pub fn build_token_url(challenge: &BearerChallenge) -> String {
    let mut url = challenge.realm.clone();
    let mut sep = if url.contains('?') { '&' } else { '?' };
    if let Some(service) = &challenge.service {
        url.push(sep);
        url.push_str("service=");
        url.push_str(service);
        sep = '&';
    }
    if let Some(scope) = &challenge.scope {
        url.push(sep);
        url.push_str("scope=");
        url.push_str(scope);
    }
    url
}

/// Extract the bearer token from a token-endpoint JSON body.
///
/// Accepts either `{"token":"…"}` (Docker) or `{"access_token":"…"}` (OAuth).
pub fn extract_token(body: &[u8]) -> Result<String, OciFetchError> {
    #[derive(serde::Deserialize)]
    struct Resp {
        #[serde(default)]
        token: Option<String>,
        #[serde(default)]
        access_token: Option<String>,
    }
    let r: Resp = serde_json::from_slice(body)
        .map_err(|e| OciFetchError::AuthTokenFetchFailed(format!("token response JSON: {e}")))?;
    r.token
        .or(r.access_token)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            OciFetchError::AuthTokenFetchFailed(
                "token response missing `token`/`access_token`".into(),
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_standard_docker_challenge() {
        let c = parse_bearer_challenge(
            r#"Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/alpine:pull""#,
        )
        .unwrap();
        assert_eq!(c.realm, "https://auth.docker.io/token");
        assert_eq!(c.service.as_deref(), Some("registry.docker.io"));
        assert_eq!(c.scope.as_deref(), Some("repository:library/alpine:pull"));
    }

    #[test]
    fn parses_unquoted() {
        let c = parse_bearer_challenge("Bearer realm=https://x/token,service=x").unwrap();
        assert_eq!(c.realm, "https://x/token");
        assert_eq!(c.service.as_deref(), Some("x"));
    }

    #[test]
    fn parses_spaces_and_mixed_case() {
        let c = parse_bearer_challenge(
            r#"bearer  Realm="https://x/token" , Service="x" , Scope="repository:foo:pull""#,
        )
        .unwrap();
        assert_eq!(c.realm, "https://x/token");
    }

    #[test]
    fn missing_realm_errors() {
        let err = parse_bearer_challenge(r#"Bearer service="x",scope="repository:foo:pull""#)
            .unwrap_err();
        assert!(matches!(err, OciFetchError::AuthChallengeMalformed(_)));
    }

    #[test]
    fn non_bearer_errors() {
        assert!(matches!(
            parse_bearer_challenge(r#"Digest realm="x""#).unwrap_err(),
            OciFetchError::AuthChallengeMalformed(_)
        ));
    }

    #[test]
    fn is_basic_detects_basic() {
        assert!(is_basic_challenge(r#"Basic realm="x""#));
        assert!(is_basic_challenge(r#"  basic realm="x""#));
        assert!(!is_basic_challenge(r#"Bearer realm="x""#));
    }

    #[test]
    fn build_url_appends_params() {
        let c = BearerChallenge {
            realm: "https://auth.example/token".into(),
            service: Some("registry".into()),
            scope: Some("repository:foo/bar:pull".into()),
        };
        assert_eq!(
            build_token_url(&c),
            "https://auth.example/token?service=registry&scope=repository:foo/bar:pull"
        );
    }

    #[test]
    fn build_url_merges_with_existing_query() {
        let c = BearerChallenge {
            realm: "https://auth.example/token?foo=1".into(),
            service: Some("registry".into()),
            scope: None,
        };
        assert_eq!(
            build_token_url(&c),
            "https://auth.example/token?foo=1&service=registry"
        );
    }

    #[test]
    fn extract_token_variants() {
        assert_eq!(extract_token(br#"{"token":"abc"}"#).unwrap(), "abc");
        assert_eq!(extract_token(br#"{"access_token":"def"}"#).unwrap(), "def");
    }

    #[test]
    fn extract_token_missing() {
        assert!(matches!(
            extract_token(br#"{"foo":"bar"}"#).unwrap_err(),
            OciFetchError::AuthTokenFetchFailed(_)
        ));
    }

    #[test]
    fn extract_token_empty() {
        assert!(matches!(
            extract_token(br#"{"token":""}"#).unwrap_err(),
            OciFetchError::AuthTokenFetchFailed(_)
        ));
    }
}
