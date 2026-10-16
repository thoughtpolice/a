// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Join tickets: what a worker needs to join a daemon, in one string.

use std::fmt;
use std::str::FromStr;

use iroh::EndpointAddr;
use iroh_tickets::endpoint::EndpointTicket;

use crate::keys::JoinKey;

/// A daemon's endpoint, with whatever addresses it had when the ticket was
/// made, and its join key. Printed as the endpoint ticket, a `.`, and the
/// key in hex; the ticket's base32 never contains a `.`.
///
/// A ticket is a credential: whoever has it can join the daemon as a
/// worker, and so produce results it will cache.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JoinTicket {
    pub daemon: EndpointAddr,
    pub key: JoinKey,
}

impl fmt::Display for JoinTicket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}.{}",
            EndpointTicket::new(self.daemon.clone()),
            self.key
        )
    }
}

/// A string that is not a join ticket.
#[derive(Debug, thiserror::Error)]
#[error("not a gonzo join ticket (an endpoint ticket, a `.`, and a hex key)")]
pub struct ParseTicketError;

impl FromStr for JoinTicket {
    type Err = ParseTicketError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let (ticket, key) = s.trim().rsplit_once('.').ok_or(ParseTicketError)?;
        let ticket = EndpointTicket::from_str(ticket).map_err(|_| ParseTicketError)?;
        Ok(Self {
            daemon: ticket.into(),
            key: key.parse().map_err(|_| ParseTicketError)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ticket_round_trips() {
        let id = iroh::SecretKey::generate().public();
        let ticket = JoinTicket {
            daemon: EndpointAddr::new(id).with_ip_addr("127.0.0.1:4433".parse().unwrap()),
            key: JoinKey::generate(),
        };
        let printed = ticket.to_string();
        assert!(printed.starts_with("endpoint"), "{printed}");
        assert_eq!(printed.parse::<JoinTicket>().unwrap(), ticket);
        assert!("endpointabc".parse::<JoinTicket>().is_err());
        assert!(format!("{printed}x").parse::<JoinTicket>().is_err());
    }
}
