// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MPL-2.0
//
// Adapted from rust-query-crlite in https://github.com/mozilla/crlite, by the
// Mozilla Foundation and contributors, under the same license.

//! Downloading filters from Firefox Remote Settings, and the enrolled
//! intermediates from the CRLite pipeline's storage.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::Path;

use log::debug;
use serde::Deserialize;

use crate::{EnrolledRecord, Error, INTERMEDIATES_FILE, Intermediates, Result};

const ENROLLED_JSON_URL_TEMPLATE: &str =
    "https://storage.googleapis.com/crlite-filters-prod/{}/enrolled.json";

/// A Remote Settings instance to download filters from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Instance {
    Prod,
    Stage,
}

impl Instance {
    /// The attachment server, and the collections of the bucket that holds
    /// the filters. These are upstream's: the filters are in
    /// `security-state-staging` on both.
    fn urls(self) -> (&'static str, &'static str) {
        match self {
            Instance::Prod => (
                "https://firefox-settings-attachments.cdn.mozilla.net/",
                "https://firefox.settings.services.mozilla.com/v1/buckets/security-state-staging/collections/",
            ),
            Instance::Stage => (
                "https://firefox-settings-attachments.cdn.allizom.org/",
                "https://firefox.settings.services.allizom.org/v1/buckets/security-state-staging/collections/",
            ),
        }
    }
}

/// A filter channel. They trade size against coverage.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    /// Every revocation.
    #[default]
    Default,
    /// Only revocations for keyCompromise, cessationOfOperation and
    /// privilegeWithdrawn.
    Compat,
}

#[derive(Deserialize)]
struct CertRevCollection {
    data: Vec<CertRevRecord>,
}

#[derive(Deserialize)]
struct CertRevRecord {
    attachment: CertRevRecordAttachment,
    incremental: bool,
    channel: Option<Channel>,
}

#[derive(Deserialize)]
struct CertRevRecordAttachment {
    hash: String,
    filename: String,
    location: String,
}

/// Bring the filters for `channel` in `dir` up to date with `instance`, then
/// fetch the intermediates enrolled for them.
pub fn update(dir: &Path, instance: Instance, channel: Channel) -> Result<()> {
    update_filters(dir, instance, channel)?;
    update_intermediates(dir)
}

fn update_filters(dir: &Path, instance: Instance, channel: Channel) -> Result<()> {
    let (attachment_url, base_url) = instance.urls();
    debug!(
        "Fetching cert-revocations records from remote settings {}",
        base_url
    );
    let records: CertRevCollection =
        reqwest::blocking::get(base_url.to_owned() + "cert-revocations/records")
            .map_err(|_| Error::new("could not fetch remote settings collection"))?
            .json()
            .map_err(|_| Error::new("could not read remote settings data"))?;

    let filters: Vec<&CertRevRecord> = records
        .data
        .iter()
        .filter(|x| x.channel.unwrap_or_default() == channel)
        .collect();

    if filters.iter().filter(|x| !x.incremental).count() != 1 {
        return Err(Error::new(
            "number of full filters found in remote settings is not 1",
        ));
    }

    let expected_filenames: HashSet<OsString> = filters
        .iter()
        .map(|x| x.attachment.filename.clone().into())
        .collect();

    // Remove any filter or delta files that are not listed in the collection.
    for entry in std::fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let extension = path.extension().and_then(|x| x.to_str());
        if (extension == Some("delta") || extension == Some("filter"))
            && !expected_filenames.contains(&entry.file_name())
        {
            debug!("Removing {:?}", entry.file_name());
            let _ = std::fs::remove_file(path);
        }
    }

    for filter in filters {
        let expected_digest = hex::decode(&filter.attachment.hash)
            .map_err(|_| Error::new("filter digest corrupted"))?;
        let path = dir.join(&filter.attachment.filename);
        if path.exists() && openssl::sha::sha256(&std::fs::read(&path)?)[..] == expected_digest[..]
        {
            debug!("Found existing copy of {}", filter.attachment.filename);
            continue;
        }

        let filter_url = format!("{}{}", attachment_url, filter.attachment.location);
        debug!(
            "Fetching {} from {}",
            filter.attachment.filename, filter_url
        );
        let filter_bytes = reqwest::blocking::get(filter_url)
            .map_err(|_| Error::new("could not fetch filter"))?
            .bytes()
            .map_err(|_| Error::new("could not read filter"))?;

        if openssl::sha::sha256(&filter_bytes)[..] != expected_digest[..] {
            return Err(Error::new("filter digest mismatch"));
        }

        std::fs::write(&path, &filter_bytes)?;
    }

    Ok(())
}

/// The `yyyymmdd-r` run ID that starts a filter's file name.
fn run_id(path: &Path) -> Option<(String, u32)> {
    let filename = path.file_name()?.to_str()?;
    let mut parts = filename.splitn(3, '-');
    let date = parts.next()?;
    let revision: u32 = parts.next()?.parse().ok()?;
    if date.len() == 8 && date.chars().all(|c| c.is_ascii_digit()) {
        Some((date.to_string(), revision))
    } else {
        None
    }
}

/// Fetch the intermediates enrolled in the most recent run whose filters
/// are in `dir`, and write them to its intermediates file.
pub fn update_intermediates(dir: &Path) -> Result<()> {
    let mut latest = None;
    for entry in std::fs::read_dir(dir)? {
        let Ok(entry) = entry else { continue };
        if let Some(id) = run_id(&entry.path()) {
            latest = latest.max(Some(id));
        }
    }
    let (date, revision) = latest
        .ok_or_else(|| Error::new("no filter files found; cannot determine enrolled.json URL"))?;

    let enrolled_url = ENROLLED_JSON_URL_TEMPLATE.replace("{}", &format!("{}-{}", date, revision));
    debug!("Fetching {}", enrolled_url);
    let records: Vec<EnrolledRecord> = reqwest::blocking::get(&enrolled_url)
        .map_err(|_| Error::new("could not fetch enrolled.json"))?
        .json()
        .map_err(|_| Error::new("could not parse enrolled.json"))?;

    let encoded = Intermediates::from_enrolled_json(&records).encode()?;
    std::fs::write(dir.join(INTERMEDIATES_FILE), encoded)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::run_id;
    use std::path::Path;

    #[test]
    fn run_ids() {
        assert_eq!(
            run_id(Path::new("/db/20261029-1-default.filter")),
            Some(("20261029".to_string(), 1))
        );
        assert_eq!(
            run_id(Path::new("20261029-12-compat.filter.delta")),
            Some(("20261029".to_string(), 12))
        );
        assert_eq!(run_id(Path::new("crlite.intermediates")), None);
        assert_eq!(run_id(Path::new("2026102-1-default.filter")), None);
    }
}
