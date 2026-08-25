// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Small human-duration parser for command-line deadlines.

use std::fmt;
use std::str::FromStr;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct HumanDuration(pub(crate) Duration);

impl FromStr for HumanDuration {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let (number, scale) = if let Some(number) = text.strip_suffix("ms") {
            (number, Duration::from_millis(1))
        } else if let Some(number) = text.strip_suffix('s') {
            (number, Duration::from_secs(1))
        } else if let Some(number) = text.strip_suffix('m') {
            (number, Duration::from_secs(60))
        } else {
            return Err("duration must end in ms, s, or m (for example 10s)".into());
        };
        let count = number
            .parse::<u32>()
            .map_err(|_| format!("invalid duration {text:?}"))?;
        if count == 0 {
            return Err("duration must be greater than zero".into());
        }
        let duration = scale
            .checked_mul(count)
            .ok_or_else(|| format!("duration {text:?} is too large"))?;
        if duration > Duration::from_secs(24 * 60 * 60) {
            return Err("duration may not exceed 24 hours".into());
        }
        Ok(Self(duration))
    }
}

impl fmt::Display for HumanDuration {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}ms", self.0.as_millis())
    }
}

#[cfg(test)]
#[path = "tests/duration.rs"]
mod tests;
