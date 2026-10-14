// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"regexp"
	"strings"
)

// The year that copyright ranges are expected to end at. This is pinned rather
// than read from the clock so a run's verdict is a function of its inputs
// alone; a wall-clock year would flip every header in the repository from
// passing to failing at midnight on January 1st with nothing having changed,
// and would let a cached pass hide that. Bumping this is the deliberate act
// that opens the new year's header sweep, and since it changes this tool, it
// reruns every srclint action.
const copyrightYear = 2026

var yearPattern = regexp.MustCompile(fmt.Sprintf(`^(2024-%d|%d)$`, copyrightYear, copyrightYear))

var allowedLicenses = []string{
	"Apache-2.0",
	"MIT",
	"BSD-2-Clause",
	"BSD-3-Clause",
	"ISC",
	// Compound licenses, in both orderings.
	"Apache-2.0 AND MIT",
	"Apache-2.0 OR MIT",
	"MIT AND Apache-2.0",
	"MIT OR Apache-2.0",
}

// A comment style is the copyright and license line prefixes a header is
// written with, without the years and identifiers that follow them.
type commentStyle struct {
	copyright, license string
}

var (
	hashStyle   = commentStyle{"# SPDX-FileCopyrightText: © ", "# SPDX-License-Identifier: "}
	slashStyle  = commentStyle{"// SPDX-FileCopyrightText: © ", "// SPDX-License-Identifier: "}
	blockStyle  = commentStyle{"/* SPDX-FileCopyrightText: © ", "/* SPDX-License-Identifier: "}
	ocamlStyle  = commentStyle{"(* SPDX-FileCopyrightText: © ", "(* SPDX-License-Identifier: "}
	lispStyle   = commentStyle{";; SPDX-FileCopyrightText: © ", ";; SPDX-License-Identifier: "}
	erlangStyle = commentStyle{"%% SPDX-FileCopyrightText: © ", "%% SPDX-License-Identifier: "}
	htmlStyle   = commentStyle{"<!-- SPDX-FileCopyrightText: © ", "<!-- SPDX-License-Identifier: "}
	llvmStyle   = commentStyle{"; SPDX-FileCopyrightText: © ", "; SPDX-License-Identifier: "}
	luaStyle    = commentStyle{"-- SPDX-FileCopyrightText: © ", "-- SPDX-License-Identifier: "}
	// A markup file whose header sits inside a block comment that opens on
	// its own line. Lines are compared after trimming, so the marker is the
	// bare tag; the opening "<!--" is skipped as a preamble.
	xmlBlockStyle = commentStyle{"SPDX-FileCopyrightText: © ", "SPDX-License-Identifier: "}
)

// lit-style test files use the comment syntax of whatever language the tool
// under test reads, so they may carry the header in any of these.
var litStyles = []commentStyle{slashStyle, hashStyle, llvmStyle, lispStyle}

// fileType says how a file whose path ends with suffix carries its header:
// in one of styles, the first of which applies unless the opening line starts
// with another. A suffix starting with "/" names a whole file name.
type fileType struct {
	suffix string
	styles []commentStyle
}

// The lookup takes the first matching entry, not the longest, so an entry
// must precede any shorter suffix of it.
var fileTypes = []fileType{
	{".py", []commentStyle{hashStyle}},
	{"BUILD", []commentStyle{hashStyle}},
	{"BUCK", []commentStyle{hashStyle}},
	{"PACKAGE", []commentStyle{hashStyle}},
	{".bzl", []commentStyle{hashStyle}},
	{".bxl", []commentStyle{hashStyle}},
	{".rs", []commentStyle{slashStyle}},
	{".cpp", []commentStyle{slashStyle}},
	{".hpp", []commentStyle{slashStyle}},
	{".h", []commentStyle{slashStyle}},
	{".c", []commentStyle{slashStyle}},
	{".go", []commentStyle{slashStyle}},
	{".ts", []commentStyle{slashStyle}},
	{".tsx", []commentStyle{slashStyle}},
	{".js", []commentStyle{slashStyle}},
	{".mjs", []commentStyle{slashStyle}},
	{".cs", []commentStyle{slashStyle}},
	{".nix", []commentStyle{hashStyle}},
	{".capnp", []commentStyle{hashStyle}},
	{".proto", []commentStyle{slashStyle}},
	{".S", []commentStyle{slashStyle}},
	{".ld", []commentStyle{blockStyle}},
	{".css", []commentStyle{blockStyle}},
	{".ml", []commentStyle{ocamlStyle}},
	{".yaml", []commentStyle{hashStyle}},
	{".fish", []commentStyle{hashStyle}},
	{".toml", []commentStyle{hashStyle}},
	// D-Bus policy files are XML that convention names ".conf".
	{"/dbus-minimos-deny.conf", []commentStyle{xmlBlockStyle}},
	{".conf", []commentStyle{hashStyle}},
	{".service", []commentStyle{hashStyle}},
	// systemd resource-control units; same "#" comments as ".service".
	{".slice", []commentStyle{hashStyle}},
	{"/group", []commentStyle{hashStyle}},
	{"/hostname", []commentStyle{hashStyle}},
	{"/hosts", []commentStyle{hashStyle}},
	{"/os-release", []commentStyle{hashStyle}},
	{"/profile", []commentStyle{hashStyle}},
	{".html", []commentStyle{htmlStyle}},
	{".wat", []commentStyle{lispStyle}},
	{".wit", []commentStyle{slashStyle}},
	{".zuo", []commentStyle{lispStyle}},
	{".sv", []commentStyle{slashStyle}},
	{".erl", []commentStyle{erlangStyle}},
	{".luau", []commentStyle{luaStyle}},
	{".lean", []commentStyle{luaStyle}},
	{".hurl", []commentStyle{hashStyle}},
	{".test", litStyles},
	{".check", litStyles},
}

// Files in a language srclint knows that still carry no header of their own:
// what a generator writes whole, and Cargo's manifests, which tooling rewrites.
// Matched against the end of the path like fileTypes.
var headerlessSuffixes = []string{
	".generated.bzl",
	"Cargo.toml",
	"reindeer.toml",
}

// spdxProblems returns what is wrong with the SPDX header of the file at path
// with contents data, or nothing if the file has a correct one or needs none.
// Only a file in a language fileTypes gives the comment syntax of needs one;
// data, documents and configuration in formats with no comments do not.
func spdxProblems(path string, data []byte) []problem {
	typ, ok := lookupFileType(path)
	if !ok || isBinary(data) || hasSuffixIn(path, headerlessSuffixes) {
		return nil
	}
	lines := splitLines(data)
	// A script names its interpreter on the first line, which is where the
	// header would go.
	if len(lines) > 0 && strings.HasPrefix(lines[0], "#!") {
		return nil
	}
	fail := func(line int, format string, args ...any) []problem {
		return []problem{{Path: path, Line: line, Check: "spdx", Message: fmt.Sprintf(format, args...)}}
	}

	style := typ.styles[0]
	if len(lines) > 0 {
		first := strings.TrimSpace(lines[0])
		for _, s := range typ.styles {
			if strings.HasPrefix(first, s.copyright) {
				style = s
				break
			}
		}
	}

	// HTML requires its doctype before other markup. Treat that declaration
	// as a format preamble, and require the header immediately after it. A
	// block comment that opens on its own line is the same kind of preamble.
	i := 0
	if len(lines) > 0 {
		first := strings.TrimSpace(lines[0])
		if typ.suffix == ".html" && strings.ToLower(first) == "<!doctype html>" {
			i = 1
		} else if style == xmlBlockStyle && first == "<!--" {
			i = 1
		}
	}

	// One or more copyright lines, then the license line.
	copyrightFound := false
	for ; i < len(lines); i++ {
		line := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(line, style.copyright) {
			break
		}
		if fields := strings.Fields(line[len(style.copyright):]); len(fields) > 0 && !yearPattern.MatchString(fields[0]) {
			return fail(i+1, "incorrect copyright year %q; expected \"2024-%d\" or \"%d\"", fields[0], copyrightYear, copyrightYear)
		}
		copyrightFound = true
	}
	if !copyrightFound {
		return fail(i+1, "missing SPDX copyright header %q", strings.TrimSpace(style.copyright))
	}
	if i >= len(lines) {
		return fail(i+1, "missing SPDX license header")
	}
	line := strings.TrimSpace(lines[i])
	if !strings.HasPrefix(line, style.license) {
		return fail(i+1, "expected SPDX license header %q", strings.TrimSpace(style.license))
	}
	license := strings.TrimSpace(line[len(style.license):])
	for _, closer := range []string{" */", " *)", " -->"} {
		if strings.HasSuffix(license, closer) {
			license = strings.TrimSpace(strings.TrimSuffix(license, closer))
			break
		}
	}
	for _, allowed := range allowedLicenses {
		if license == allowed {
			return nil
		}
	}
	return fail(i+1, "unsupported license %q; allowed: %s", license, strings.Join(allowedLicenses, ", "))
}

func lookupFileType(path string) (fileType, bool) {
	for _, t := range fileTypes {
		if matchesSuffix(path, t.suffix) {
			return t, true
		}
	}
	return fileType{}, false
}

// matchesSuffix reports whether path ends with suffix, where a suffix
// starting with "/" also matches a bare file name with no directory.
func matchesSuffix(path, suffix string) bool {
	return strings.HasSuffix(path, suffix) ||
		(strings.HasPrefix(suffix, "/") && path == suffix[1:])
}

func hasSuffixIn(path string, suffixes []string) bool {
	for _, s := range suffixes {
		if matchesSuffix(path, s) {
			return true
		}
	}
	return false
}
