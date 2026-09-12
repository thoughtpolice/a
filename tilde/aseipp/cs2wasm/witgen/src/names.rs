// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! WIT identifiers are kebab-case; C# wants PascalCase members, camelCase
//! parameters and no collisions with keywords.

const KEYWORDS: &[&str] = &[
    "abstract",
    "as",
    "base",
    "bool",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "checked",
    "class",
    "const",
    "continue",
    "decimal",
    "default",
    "delegate",
    "do",
    "double",
    "else",
    "enum",
    "event",
    "explicit",
    "extern",
    "false",
    "finally",
    "fixed",
    "float",
    "for",
    "foreach",
    "goto",
    "if",
    "implicit",
    "in",
    "int",
    "interface",
    "internal",
    "is",
    "lock",
    "long",
    "namespace",
    "new",
    "null",
    "object",
    "operator",
    "out",
    "override",
    "params",
    "private",
    "protected",
    "public",
    "readonly",
    "ref",
    "return",
    "sbyte",
    "sealed",
    "short",
    "sizeof",
    "stackalloc",
    "static",
    "string",
    "struct",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "uint",
    "ulong",
    "unchecked",
    "unsafe",
    "ushort",
    "using",
    "virtual",
    "void",
    "volatile",
    "while",
];

/// `fill-rect` to `FillRect`, `%list` to `List`.
pub fn pascal(name: &str) -> String {
    name.trim_start_matches('%')
        .split(['-', '_', '.'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            match chars.next() {
                Some(first) => first.to_ascii_uppercase().to_string() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect()
}

/// `dt-ms` to `dtMs`, escaped when it would be a keyword.
pub fn camel(name: &str) -> String {
    let pascal = pascal(name);
    let mut chars = pascal.chars();
    let camel = match chars.next() {
        Some(first) => first.to_ascii_lowercase().to_string() + chars.as_str(),
        None => String::new(),
    };
    if KEYWORDS.contains(&camel.as_str()) {
        format!("@{camel}")
    } else {
        camel
    }
}

/// `console:sdk` to `Console.Sdk`.
pub fn namespace(package_namespace: &str, package_name: &str) -> String {
    format!("{}.{}", pascal(package_namespace), pascal(package_name))
}

/// The class for an interface or world: PascalCase, unless that would shadow
/// a namespace gameplay code needs, as an interface called `system` would
/// shadow `System.Math`.
pub fn class(name: &str) -> String {
    let class = pascal(name);
    match class.as_str() {
        "System" | "Microsoft" | "Gameplay" => class + "Interface",
        _ => class,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cases() {
        assert_eq!(pascal("fill-rect"), "FillRect");
        assert_eq!(pascal("%list"), "List");
        assert_eq!(pascal("kp-enter"), "KpEnter");
        assert_eq!(camel("dt-ms"), "dtMs");
        assert_eq!(camel("params"), "@params");
        assert_eq!(camel("x"), "x");
        assert_eq!(namespace("console", "sdk"), "Console.Sdk");
        assert_eq!(class("gfx"), "Gfx");
        assert_eq!(class("system"), "SystemInterface");
    }
}
