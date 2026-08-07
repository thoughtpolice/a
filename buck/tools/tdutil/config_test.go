// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"slices"
	"strings"
	"testing"
)

func testAuditedConfig(t *testing.T, raw string) map[string]map[string]string {
	t.Helper()
	parsed, err := parseAuditedConfig([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func TestParseAuditedConfigSplitsCellQualifiedKeys(t *testing.T) {
	parsed := testAuditedConfig(t, `{"root//buildfile.name":"BUILD,BUCK","nested//tdutil.ci_deps_attribute":"deps"}`)
	if got := parsed["root"]["buildfile.name"]; got != "BUILD,BUCK" {
		t.Errorf("root buildfile.name = %q", got)
	}
	if got := parsed["nested"]["tdutil.ci_deps_attribute"]; got != "deps" {
		t.Errorf("nested ci_deps_attribute = %q", got)
	}
	for _, bad := range []string{`[]`, `{"nocell":"x"}`, `{"root//buildfile.name":5}`} {
		if _, err := parseAuditedConfig([]byte(bad)); err == nil {
			t.Errorf("accepted malformed audit output %s", bad)
		}
	}
}

// Build file names follow buck2's own precedence, which a repository other
// than this one is entitled to rely on: name_v2 wins outright, a bare name
// gains its .v2 sibling, and a cell which says nothing gets buck2's default.
func TestBuildFileNamesFollowBuckPrecedencePerCell(t *testing.T) {
	cells := assembleCellMap(map[string]string{
		"root":   "",
		"legacy": "vendor/legacy",
		"modern": "vendor/modern",
		"quiet":  "vendor/quiet",
	}, nil)
	matcher, err := newBuildFileMatcher(cells, testAuditedConfig(t, `{
		"root//buildfile.name":"BUILD,BUCK",
		"legacy//buildfile.name":"TARGETS",
		"modern//buildfile.name_v2":"ONLY.v2",
		"modern//buildfile.name":"IGNORED",
		"quiet//buildfile.extra_for_test":"EXTRA"
	}`))
	if err != nil {
		t.Fatal(err)
	}

	for _, want := range []struct {
		path  string
		names []string
	}{
		{"src/app/BUILD", []string{"BUILD.v2", "BUILD", "BUCK.v2", "BUCK"}},
		{"vendor/legacy/x/BUILD", []string{"TARGETS.v2", "TARGETS"}},
		{"vendor/modern/x/BUILD", []string{"ONLY.v2"}},
		{"vendor/quiet/x/BUILD", []string{"BUCK.v2", "BUCK", "EXTRA"}},
	} {
		if got := matcher.namesFor(want.path); !slices.Equal(got, want.names) {
			t.Errorf("names for %s = %v, want %v", want.path, got, want.names)
		}
	}

	// A nested cell's root is a longer prefix than the root cell's, so it wins.
	if !matcher.isBuildFile("vendor/legacy/x/TARGETS") {
		t.Error("nested cell did not match its own build file")
	}
	if matcher.isBuildFile("vendor/legacy/x/BUILD") {
		t.Error("nested cell matched the root cell's build file name")
	}
	if !matcher.isBuildFile("src/app/BUILD") || !matcher.isBuildFile("src/app/BUCK") {
		t.Error("root cell did not match its own build files")
	}
	// The cell root itself is inside the cell, not merely a prefix of it.
	if !matcher.isBuildFile("vendor/legacy/TARGETS") {
		t.Error("cell root directory was not treated as part of the cell")
	}
	// A sibling path sharing a textual prefix is a different directory.
	if matcher.isBuildFile("vendor/legacy-extra/TARGETS") {
		t.Error("prefix collision matched a neighbouring directory")
	}
}

func TestBuildFileMatcherFallsBackToBuckDefaults(t *testing.T) {
	// No cells resolved at all — the shape a snapshot reader or a test starts
	// from — still answers with buck2's built-in names rather than nothing.
	empty := buildFileMatcher{}
	if !empty.isBuildFile("a/BUCK") || !empty.isBuildFile("a/BUCK.v2") {
		t.Error("empty matcher did not fall back to the Buck defaults")
	}
	if empty.isBuildFile("a/BUILD") {
		t.Error("empty matcher matched a name buck2 does not use by default")
	}
}

func TestPackageFilesAreBuckSpelled(t *testing.T) {
	for _, name := range []string{"PACKAGE", "BUCK_TREE"} {
		if !isPackageFile(name) {
			t.Errorf("%s is not recognised as a package file", name)
		}
	}
	for _, name := range []string{"PACKAGE.v2", "package", "BUILD"} {
		if isPackageFile(name) {
			t.Errorf("%s was wrongly recognised as a package file", name)
		}
	}
}

func TestTdutilSectionOverridesConventionNames(t *testing.T) {
	cells := assembleCellMap(map[string]string{"root": "", "other": "sub"}, nil)
	config, err := newTdutilConfig(cells, testAuditedConfig(t, `{
		"root//tdutil.global_config_paths":"buck/mode, ci/modes ",
		"root//tdutil.ci_srcs_attribute":"test_srcs",
		"root//tdutil.ci_srcs_must_match_attribute":"test_srcs_gate",
		"root//tdutil.ci_deps_attribute":"test_deps",
		"root//tdutil.ci_hint_rule":"test_hint",
		"root//tdutil.skip_upstream_label":"ci:stop",
		"other//tdutil.ci_srcs_attribute":"ignored_because_not_the_root_cell"
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if config.rootCell != "root" {
		t.Errorf("root cell = %q", config.rootCell)
	}
	if config.ciSrcsAttribute != "test_srcs" || config.ciSrcsMustMatch != "test_srcs_gate" {
		t.Errorf("ci_srcs names = %q / %q", config.ciSrcsAttribute, config.ciSrcsMustMatch)
	}
	if config.ciDepsAttribute != "test_deps" || config.ciHintRule != "test_hint" {
		t.Errorf("ci_deps / ci_hint = %q / %q", config.ciDepsAttribute, config.ciHintRule)
	}
	if config.skipUpstreamLabel != "ci:stop" {
		t.Errorf("skip label = %q", config.skipUpstreamLabel)
	}
	if !slices.Equal(config.globalConfigPaths, []string{"buck/mode", "ci/modes"}) {
		t.Errorf("global config paths = %v", config.globalConfigPaths)
	}

	attributes := targetAttributesFor(config)
	for _, want := range []string{"^test_srcs$", "^test_srcs_gate$", "^test_deps$", `^buck\.`, "^labels$"} {
		if !strings.Contains(attributes, want) {
			t.Errorf("attribute regex %q lacks %q", attributes, want)
		}
	}
	if strings.Contains(attributes, "ci_srcs") {
		t.Errorf("attribute regex %q still asks for the default names", attributes)
	}
}

func TestUnconfiguredRepositoryKeepsTheDocumentedDefaults(t *testing.T) {
	cells := assembleCellMap(map[string]string{"root": ""}, nil)
	config, err := newTdutilConfig(cells, nil)
	if err != nil {
		t.Fatal(err)
	}
	if config.ciSrcsAttribute != defaultCiSrcsAttribute ||
		config.ciSrcsMustMatch != defaultCiSrcsMustMatchAttribute ||
		config.ciDepsAttribute != defaultCiDepsAttribute ||
		config.ciHintRule != defaultCiHintRule ||
		config.skipUpstreamLabel != defaultSkipUpstreamLabel {
		t.Fatalf("defaults not applied: %+v", config)
	}
	if len(config.globalConfigPaths) != 0 {
		t.Errorf("global config paths = %v, want none", config.globalConfigPaths)
	}
}

// An attribute name reaches buck2 as part of a regex and reaches the JSON
// parser as a literal key, so a value that is not an identifier is refused at
// the point it is read rather than silently matching nothing.
func TestConfigRejectsUnusableAttributeNames(t *testing.T) {
	cells := assembleCellMap(map[string]string{"root": ""}, nil)
	for _, bad := range []string{`"a b"`, `"a\"b"`, `"a'b"`} {
		raw := `{"root//tdutil.ci_srcs_attribute":` + bad + `}`
		if _, err := newTdutilConfig(cells, testAuditedConfig(t, raw)); err == nil {
			t.Errorf("accepted attribute name %s", bad)
		}
	}
}

// The digest keys the snapshot cache, so any resolved value it does not cover
// is one a stale document could disagree about undetected.
func TestConfigDigestCoversEveryResolvedValue(t *testing.T) {
	base := defaultTdutilConfig()
	base.rootCell = "root"
	base.buildFiles = buildFileMatcher{cells: []cellBuildFiles{{root: "", names: []string{"BUILD"}}}}

	mutations := map[string]func(*tdutilConfig){
		"root cell":       func(c *tdutilConfig) { c.rootCell = "other" },
		"config paths":    func(c *tdutilConfig) { c.globalConfigPaths = []string{"buck/mode"} },
		"ci_srcs":         func(c *tdutilConfig) { c.ciSrcsAttribute = "other" },
		"ci_srcs gate":    func(c *tdutilConfig) { c.ciSrcsMustMatch = "other" },
		"ci_deps":         func(c *tdutilConfig) { c.ciDepsAttribute = "other" },
		"ci_hint":         func(c *tdutilConfig) { c.ciHintRule = "other" },
		"skip label":      func(c *tdutilConfig) { c.skipUpstreamLabel = "other" },
		"build file name": func(c *tdutilConfig) { c.buildFiles.cells[0].names = []string{"BUCK"} },
		"cell root": func(c *tdutilConfig) {
			c.buildFiles.cells = []cellBuildFiles{{root: "sub", names: []string{"BUILD"}}}
		},
	}
	for name, mutate := range mutations {
		altered := base
		altered.buildFiles.cells = slices.Clone(base.buildFiles.cells)
		mutate(&altered)
		if altered.digest() == base.digest() {
			t.Errorf("changing the %s did not change the digest", name)
		}
	}
	if base.digest() != base.digest() {
		t.Error("digest is not stable across calls")
	}
}

func TestNormalizeConfigPathsIsOrderAndSpellingIndependent(t *testing.T) {
	first := normalizeConfigPaths([]string{"buck/mode", "/ci/modes/", "buck/mode"})
	second := normalizeConfigPaths([]string{"ci/modes", `buck\mode`})
	if !slices.Equal(first, second) {
		t.Fatalf("normalized %v and %v differently", first, second)
	}
	if !slices.Equal(first, []string{"buck/mode", "ci/modes"}) {
		t.Fatalf("normalized = %v", first)
	}
}
