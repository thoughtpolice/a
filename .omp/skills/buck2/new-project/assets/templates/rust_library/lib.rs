// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

pub fn example() {
    println!("Example function from {PROJECT_NAME}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_example() {
        example();
    }
}
