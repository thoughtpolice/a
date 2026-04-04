#!/usr/bin/env python3
# SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
# SPDX-License-Identifier: Apache-2.0

"""
Buck2 project scaffolding tool.

Creates new projects with proper BUILD/PACKAGE files, SPDX headers,
and language-specific templates.
"""

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Dict, List


class ProjectScaffolder:
    """Scaffolds Buck2 projects with proper structure and metadata."""

    TEMPLATES_DIR = Path(__file__).parent.parent / "assets" / "templates"

    SUPPORTED_TYPES = ["rust_binary", "rust_library", "deno_binary"]

    def __init__(
        self,
        project_type: str,
        name: str,
        path: str,
        description: str = "",
        author: str = "Austin Seipp",
        license: str = "Apache-2.0",
        version: str = "1.0.0",
        visibility: str = '["PUBLIC"]',
    ):
        self.project_type = project_type
        self.name = name
        self.path = Path(path)
        self.description = description or f"{name} project"
        self.author = author
        self.license = license
        self.version = version
        self.visibility = visibility
        self.year = datetime.now().year

    def validate(self) -> None:
        """Validate project configuration."""
        if self.project_type not in self.SUPPORTED_TYPES:
            raise ValueError(
                f"Invalid project type: {self.project_type}. "
                f"Supported: {', '.join(self.SUPPORTED_TYPES)}"
            )

        if self.path.exists():
            raise FileExistsError(f"Directory already exists: {self.path}")

        if not self.name:
            raise ValueError("Project name cannot be empty")

    def create_directories(self) -> None:
        """Create project directory structure."""
        self.path.mkdir(parents=True, exist_ok=False)

        # Create src directory for Rust projects
        if self.project_type.startswith("rust_"):
            (self.path / "src").mkdir(exist_ok=True)

    def get_spdx_header(self, comment_style: str = "//") -> str:
        """Generate SPDX header for source files."""
        if comment_style == "//":
            return f"""// SPDX-FileCopyrightText: © {self.year} {self.author}
// SPDX-License-Identifier: {self.license}
"""
        elif comment_style == "#":
            return f"""# SPDX-FileCopyrightText: © {self.year} {self.author}
# SPDX-License-Identifier: {self.license}
"""
        return ""

    def generate_build_file(self) -> str:
        """Generate BUILD file content."""
        if self.project_type == "rust_binary":
            return f'''load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_binary(
    name = "{self.name}",
    srcs = glob(["src/**/*.rs"]),
    deps = [
        "third-party//by-name/mi/mimalloc:rust",
    ],
    visibility = {self.visibility},
)
'''

        elif self.project_type == "rust_library":
            return f'''load("@root//buck/shims:shims.bzl", depot = "shims")

depot.rust_library(
    name = "{self.name}",
    srcs = glob(["src/**/*.rs"]),
    visibility = {self.visibility},
)
'''

        elif self.project_type == "deno_binary":
            return f'''load("@root//buck/shims:shims.bzl", depot = "shims")
load("@toolchains//deno:defs.bzl", deno = "rules")

deno.binary(
    name = "{self.name}",
    main = "main.ts",
    permissions = ["read", "write"],
    visibility = {self.visibility},
)
'''

        raise ValueError(f"Unknown project type: {self.project_type}")

    def generate_package_file(self) -> str:
        """Generate PACKAGE file content."""
        return f'''load("@root//buck/shims:package.bzl", pkg = "package")

pkg.info(
    copyright = ["© {self.year} {self.author}"],
    license = "{self.license}",
    description = "{self.description}",
    version = "{self.version}",
)
'''

    def generate_source_file(self) -> tuple[str, str]:
        """Generate source file content and filename."""
        if self.project_type == "rust_binary":
            content = f'''{self.get_spdx_header("//")}
fn main() {{
    println!("Hello from {self.name}!");
}}
'''
            return ("src/main.rs", content)

        elif self.project_type == "rust_library":
            content = f'''{self.get_spdx_header("//")}
pub fn example() {{
    println!("Example function from {self.name}");
}}

#[cfg(test)]
mod tests {{
    use super::*;

    #[test]
    fn test_example() {{
        example();
    }}
}}
'''
            return ("src/lib.rs", content)

        elif self.project_type == "deno_binary":
            content = f'''{self.get_spdx_header("//")}
function main() {{
  console.log("Hello from {self.name}!");
}}

if (import.meta.main) {{
  main();
}}
'''
            return ("main.ts", content)

        raise ValueError(f"Unknown project type: {self.project_type}")

    def scaffold(self) -> None:
        """Create the complete project structure."""
        print(f"Creating {self.project_type} project: {self.name}")
        print(f"Location: {self.path}")

        # Validate before doing anything
        self.validate()

        # Create directories
        self.create_directories()
        print(f"  ✓ Created directory: {self.path}")

        # Write BUILD file
        build_content = self.generate_build_file()
        build_path = self.path / "BUILD"
        build_path.write_text(build_content)
        print(f"  ✓ Created BUILD file")

        # Write PACKAGE file
        package_content = self.generate_package_file()
        package_path = self.path / "PACKAGE"
        package_path.write_text(package_content)
        print(f"  ✓ Created PACKAGE file")

        # Write source file
        source_filename, source_content = self.generate_source_file()
        source_path = self.path / source_filename
        source_path.write_text(source_content)
        print(f"  ✓ Created {source_filename}")

        print(f"\n✅ Project created successfully!")
        print(f"\nNext steps:")
        print(f"  1. Build:  buck2 build //{self.path}:{self.name}")
        print(f"  2. Edit:   Edit {self.path}/{source_filename}")
        print(f"  3. Test:   Add tests to BUILD and run buck2 test")


def main():
    parser = argparse.ArgumentParser(
        description="Scaffold new Buck2 projects with proper structure",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Create Rust binary
  %(prog)s --type rust_binary --name mytool --path src/tools/mytool

  # Create Rust library with custom metadata
  %(prog)s --type rust_library --name mylib --path src/lib/mylib \\
    --description "My library" --author "Jane Doe"

  # Create Deno binary
  %(prog)s --type deno_binary --name formatter --path src/tools/formatter
        """,
    )

    parser.add_argument(
        "--type",
        required=True,
        choices=ProjectScaffolder.SUPPORTED_TYPES,
        help="Project type to create",
    )

    parser.add_argument(
        "--name",
        required=True,
        help="Target name (used in BUILD file)",
    )

    parser.add_argument(
        "--path",
        required=True,
        help="Directory path relative to repo root",
    )

    parser.add_argument(
        "--description",
        default="",
        help="Brief description for PACKAGE metadata",
    )

    parser.add_argument(
        "--author",
        default="Austin Seipp",
        help="Copyright holder name (default: Austin Seipp)",
    )

    parser.add_argument(
        "--license",
        default="Apache-2.0",
        help="SPDX license identifier (default: Apache-2.0)",
    )

    parser.add_argument(
        "--version",
        default="1.0.0",
        help="Initial version (default: 1.0.0)",
    )

    parser.add_argument(
        "--visibility",
        default='["PUBLIC"]',
        help='Visibility list (default: ["PUBLIC"])',
    )

    args = parser.parse_args()

    try:
        scaffolder = ProjectScaffolder(
            project_type=args.type,
            name=args.name,
            path=args.path,
            description=args.description,
            author=args.author,
            license=args.license,
            version=args.version,
            visibility=args.visibility,
        )
        scaffolder.scaffold()
        return 0

    except (ValueError, FileExistsError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Unexpected error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 2


if __name__ == "__main__":
    sys.exit(main())
