// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: MPL-2.0
//
// Adapted from rust-query-crlite in https://github.com/mozilla/crlite, by the
// Mozilla Foundation and contributors, under the same license.

//! Certificate revocation checks against Firefox's CRLite filters.
//!
//! CRLite compresses the revocation status of every certificate in the
//! WebPKI that was logged to Certificate Transparency into a set of
//! filters, published through Firefox's Remote Settings.
