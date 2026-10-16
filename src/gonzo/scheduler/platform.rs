// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Which workers may run which actions.
//!
//! An action's platform names properties the worker that runs it must have
//! (Buck sends `OSFamily`, `Arch` and `container-image`, from
//! `buck/platforms/defs.bzl`). A worker offers a set of values per property,
//! and runs an action if it offers every property the action asks for. A
//! property the worker has never heard of is one it does not have.

use std::collections::BTreeSet;
use std::fmt;

use protos::build::bazel::remote::execution::v2::{Platform, platform::Property};

/// What an action asks of its worker: its platform's properties, as a set,
/// so that platforms listing the same properties in another order (or
/// twice) are the same.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Requirements(BTreeSet<(String, String)>);

impl Requirements {
    pub fn new(platform: Option<&Platform>) -> Self {
        Self(pairs(platform.map_or(&[][..], |p| &p.properties)))
    }
}

impl fmt::Display for Requirements {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        list(f, &self.0, "no properties")
    }
}

/// What a worker offers: every value it accepts for each property.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Offer(BTreeSet<(String, String)>);

impl Offer {
    pub fn new(properties: &[Property]) -> Self {
        Self(pairs(properties))
    }

    /// Whether a worker offering this may run an action asking `wanted`.
    pub fn satisfies(&self, wanted: &Requirements) -> bool {
        wanted.0.is_subset(&self.0)
    }
}

impl fmt::Display for Offer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        list(f, &self.0, "nothing")
    }
}

fn pairs(properties: &[Property]) -> BTreeSet<(String, String)> {
    properties
        .iter()
        .map(|p| (p.name.clone(), p.value.clone()))
        .collect()
}

/// `name=value, ...` in order, or `empty` for none.
fn list(
    f: &mut fmt::Formatter<'_>,
    pairs: &BTreeSet<(String, String)>,
    empty: &str,
) -> fmt::Result {
    if pairs.is_empty() {
        return f.write_str(empty);
    }
    for (i, (name, value)) in pairs.iter().enumerate() {
        if i > 0 {
            f.write_str(", ")?;
        }
        write!(f, "{name}={value}")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn properties(pairs: &[(&str, &str)]) -> Vec<Property> {
        pairs
            .iter()
            .map(|(name, value)| Property {
                name: name.to_string(),
                value: value.to_string(),
            })
            .collect()
    }

    fn wants(pairs: &[(&str, &str)]) -> Requirements {
        Requirements::new(Some(&Platform {
            properties: properties(pairs),
        }))
    }

    fn offers(pairs: &[(&str, &str)]) -> Offer {
        Offer::new(&properties(pairs))
    }

    const BUCK_AMD64: &[(&str, &str)] = &[
        ("OSFamily", "Linux"),
        ("Arch", "amd64"),
        ("container-image", "host"),
    ];

    #[test]
    fn a_worker_runs_actions_it_has_every_property_for() {
        let worker = offers(BUCK_AMD64);
        assert!(worker.satisfies(&wants(BUCK_AMD64)));
        assert!(worker.satisfies(&wants(&[("Arch", "amd64")])));
        assert!(!worker.satisfies(&wants(&[("Arch", "arm64")])));
        // A property the worker never mentioned is one it lacks.
        assert!(!worker.satisfies(&wants(&[("gpu", "nvidia")])));
    }

    #[test]
    fn no_properties_runs_anywhere() {
        assert!(offers(&[]).satisfies(&Requirements::new(None)));
        assert!(offers(BUCK_AMD64).satisfies(&wants(&[])));
    }

    #[test]
    fn a_worker_may_offer_several_values_of_a_property() {
        let worker = offers(&[
            ("Arch", "amd64"),
            ("container-image", "host"),
            ("container-image", "docker://static"),
        ]);
        assert!(worker.satisfies(&wants(&[("container-image", "host")])));
        assert!(worker.satisfies(&wants(&[("container-image", "docker://static")])));
        assert!(!worker.satisfies(&wants(&[("container-image", "docker://other")])));
    }

    #[test]
    fn order_and_repetition_do_not_change_requirements() {
        assert_eq!(
            wants(&[("b", "2"), ("a", "1"), ("b", "2")]),
            wants(&[("a", "1"), ("b", "2")])
        );
        assert_eq!(wants(&[("b", "2"), ("a", "1")]).to_string(), "a=1, b=2");
        assert_eq!(Requirements::new(None).to_string(), "no properties");
    }
}
