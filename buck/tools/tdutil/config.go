// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"
)

// Everything tdutil needs to know about a repository's conventions beyond the
// Buck graph itself: which paths invalidate the whole graph, what the CI
// metadata attributes are called, and which files each cell treats as build
// files. All of it is read from buckconfig so that a repository other than the
// one tdutil grew up in can describe itself rather than being assumed.
//
// The defaults reproduce the values which used to be compiled in, so a
// repository that says nothing keeps its previous behaviour.
const (
	defaultCiSrcsAttribute          = "ci_srcs"
	defaultCiSrcsMustMatchAttribute = "ci_srcs_must_match"
	defaultCiDepsAttribute          = "ci_deps"
	defaultCiHintRule               = "ci_hint"
	defaultSkipUpstreamLabel        = "ci:dangerously_skip_upstream"
)

// buck2's own fallback when a cell sets neither `buildfile.name_v2` nor
// `buildfile.name`; see DEFAULT_BUILDFILES in buck2's buildfiles.rs.
var defaultBuildFileNames = []string{"BUCK.v2", "BUCK"}

// The files buck2 evaluates as PACKAGE files, from
// PackageFilePath::package_file_names. buck2 does not make this configurable,
// so neither does tdutil: inventing a knob here would only let a repository
// describe something buck2 will not do.
var packageFileNames = []string{"BUCK_TREE", "PACKAGE"}

type tdutilConfig struct {
	// rootCell is the cell rooted at the repository root. It is derived from
	// the cell map rather than configured, and names the default universe.
	rootCell          string
	globalConfigPaths []string
	ciSrcsAttribute   string
	ciSrcsMustMatch   string
	ciDepsAttribute   string
	ciHintRule        string
	skipUpstreamLabel string
	buildFiles        buildFileMatcher
}

// defaultTdutilConfig is what an unconfigured repository gets, and what tests
// and snapshot readers fall back to when no buckconfig is at hand.
func defaultTdutilConfig() tdutilConfig {
	return tdutilConfig{
		ciSrcsAttribute:   defaultCiSrcsAttribute,
		ciSrcsMustMatch:   defaultCiSrcsMustMatchAttribute,
		ciDepsAttribute:   defaultCiDepsAttribute,
		ciHintRule:        defaultCiHintRule,
		skipUpstreamLabel: defaultSkipUpstreamLabel,
	}
}

// withDefaults fills in anything a caller left unset. The defaults are the
// documented behaviour, so a partially built config behaves like an
// unconfigured repository rather than like one whose CI attributes are all
// named the empty string.
func (config tdutilConfig) withDefaults() tdutilConfig {
	defaults := defaultTdutilConfig()
	if config.ciSrcsAttribute == "" {
		config.ciSrcsAttribute = defaults.ciSrcsAttribute
	}
	if config.ciSrcsMustMatch == "" {
		config.ciSrcsMustMatch = defaults.ciSrcsMustMatch
	}
	if config.ciDepsAttribute == "" {
		config.ciDepsAttribute = defaults.ciDepsAttribute
	}
	if config.ciHintRule == "" {
		config.ciHintRule = defaults.ciHintRule
	}
	if config.skipUpstreamLabel == "" {
		config.skipUpstreamLabel = defaults.skipUpstreamLabel
	}
	return config
}

// A cell's build file names apply to every package beneath its root, so
// resolving a path means finding the cell whose root is its longest prefix.
type cellBuildFiles struct {
	root  string
	names []string
}

type buildFileMatcher struct {
	// Sorted longest root first, which puts the root cell — whose root is the
	// empty string and therefore prefixes everything — last.
	cells []cellBuildFiles
}

func (matcher buildFileMatcher) namesFor(repoPath string) []string {
	for _, cell := range matcher.cells {
		if cell.root == "" || repoPath == cell.root || strings.HasPrefix(repoPath, cell.root+"/") {
			return cell.names
		}
	}
	return defaultBuildFileNames
}

func (matcher buildFileMatcher) isBuildFile(repoPath string) bool {
	return slices.Contains(matcher.namesFor(repoPath), pathBase(repoPath))
}

func isPackageFile(name string) bool {
	return slices.Contains(packageFileNames, name)
}

// isGlobalConfiguration reports whether changing a path changes how the whole
// graph is configured, which no target-by-target comparison can model. The
// well-known Buck names are recognised everywhere; `global_config_paths`
// covers whatever else a repository keeps its build modes and argument files
// in, which is otherwise invisible to us and would silently under-select.
func (config tdutilConfig) isGlobalConfiguration(path string) bool {
	name := pathBase(path)
	if name == ".buckroot" || strings.HasSuffix(name, ".buckconfig") ||
		strings.HasSuffix(name, ".bcfg") || strings.HasSuffix(name, ".buckargs") {
		return true
	}
	for _, component := range strings.Split(path, "/") {
		if component == ".buckconfig.d" || component == "buckconfigs" {
			return true
		}
	}
	for _, configured := range config.globalConfigPaths {
		if path == configured || strings.HasPrefix(path, configured+"/") {
			return true
		}
	}
	return false
}

// digest folds the resolved configuration into the snapshot identity. Two runs
// which disagree about what `ci_srcs` is called, or about which files are
// build files, produce documents that describe the same graph differently, so
// they must not share a cache entry. Fields are length-prefixed for the same
// reason snapshotIdentity.digest does it: so that neighbouring values cannot
// be concatenated into a collision.
func (config tdutilConfig) digest() string {
	hash := sha256.New()
	writeFramedField(hash, "root-cell", config.rootCell)
	writeFramedList(hash, "global-config-paths", config.globalConfigPaths)
	writeFramedField(hash, "ci-srcs", config.ciSrcsAttribute)
	writeFramedField(hash, "ci-srcs-must-match", config.ciSrcsMustMatch)
	writeFramedField(hash, "ci-deps", config.ciDepsAttribute)
	writeFramedField(hash, "ci-hint-rule", config.ciHintRule)
	writeFramedField(hash, "skip-upstream-label", config.skipUpstreamLabel)
	writeFramedField(hash, "build-files", "")
	for _, cell := range config.buildFiles.cells {
		writeFramedField(hash, "cell-root", cell.root)
		writeFramedList(hash, "cell-build-files", cell.names)
	}
	return hex.EncodeToString(hash.Sum(nil))[:16]
}

// resolveRepositoryConfig reads the cell layout and the conventions built on
// top of it. Two buck2 queries against the invoking repository, run once for
// the whole program: everything downstream is derived from the result.
func resolveRepositoryConfig(
	ctx context.Context,
	runner processRunner,
	args *cliArgs,
	repository string,
) (tdutilConfig, error) {
	cells, err := auditCells(ctx, runner, repository, args.buck, args.buckArgs, args.isolationDir)
	if err != nil {
		return tdutilConfig{}, err
	}
	return loadTdutilConfig(ctx, runner, repository, args.buck, args.buckArgs, args.isolationDir, cells)
}

// loadTdutilConfig reads the repository's conventions out of buckconfig. One
// `--all-cells` query answers both halves: the per-cell build file names, and
// the root cell's [tdutil] section.
func loadTdutilConfig(
	ctx context.Context,
	runner processRunner,
	repository, buck string,
	buckArgs []string,
	isolation string,
	cells cellMap,
) (tdutilConfig, error) {
	args := isolationArgs(isolation)
	args = append(args, "audit", "config", "--all-cells", "--json")
	args = append(args, buckArgs...)
	args = append(args,
		"buildfile.name",
		"buildfile.name_v2",
		"buildfile.extra_for_test",
		"tdutil",
	)
	result, err := runner.run(ctx, commandSpec{path: buck, args: args, dir: repository})
	if err != nil {
		return tdutilConfig{}, fmt.Errorf("failed to run `%s audit config` in `%s`: %w", buck, repository, err)
	}
	if err := ensureBuckProcessSuccess("buck2 audit config", result); err != nil {
		return tdutilConfig{}, err
	}
	audited, err := parseAuditedConfig(result.stdout)
	if err != nil {
		return tdutilConfig{}, err
	}
	return newTdutilConfig(cells, audited)
}

// parseAuditedConfig turns `buck2 audit config --all-cells --json` output into
// a per-cell view. Keys arrive as `cell//section.key`.
func parseAuditedConfig(data []byte) (map[string]map[string]string, error) {
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("invalid JSON from `buck2 audit config`: input is not UTF-8")
	}
	if err := validateJSONUnicodeEscapes(data); err != nil {
		return nil, fmt.Errorf("invalid JSON from `buck2 audit config`: %w", err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("invalid JSON from `buck2 audit config`: %w", err)
	}
	if raw == nil {
		return nil, fmt.Errorf("`buck2 audit config --json` did not return an object")
	}
	result := make(map[string]map[string]string, len(raw))
	for qualified, rawValue := range raw {
		cell, key, ok := strings.Cut(qualified, "//")
		if !ok {
			return nil, fmt.Errorf("`buck2 audit config` returned key `%s` without a cell", qualified)
		}
		value, ok := rawValue.(string)
		if !ok {
			return nil, fmt.Errorf("`buck2 audit config` value for `%s` is not a string", qualified)
		}
		if result[cell] == nil {
			result[cell] = make(map[string]string)
		}
		result[cell][key] = value
	}
	return result, nil
}

func newTdutilConfig(cells cellMap, audited map[string]map[string]string) (tdutilConfig, error) {
	config := defaultTdutilConfig()
	config.rootCell = cells.rootCell()

	// Repository-wide policy is read from the root cell. tdutil always runs
	// buck2 from the repository root, so this is also the cell buckconfig
	// resolution would have picked from the working directory.
	section := audited[config.rootCell]
	config.globalConfigPaths = normalizeConfigPaths(configList(section, "tdutil.global_config_paths"))
	config.ciSrcsAttribute = configString(section, "tdutil.ci_srcs_attribute", defaultCiSrcsAttribute)
	config.ciSrcsMustMatch = configString(section, "tdutil.ci_srcs_must_match_attribute", defaultCiSrcsMustMatchAttribute)
	config.ciDepsAttribute = configString(section, "tdutil.ci_deps_attribute", defaultCiDepsAttribute)
	config.ciHintRule = configString(section, "tdutil.ci_hint_rule", defaultCiHintRule)
	config.skipUpstreamLabel = configString(section, "tdutil.skip_upstream_label", defaultSkipUpstreamLabel)

	for _, name := range []struct{ key, value string }{
		{"tdutil.ci_srcs_attribute", config.ciSrcsAttribute},
		{"tdutil.ci_srcs_must_match_attribute", config.ciSrcsMustMatch},
		{"tdutil.ci_deps_attribute", config.ciDepsAttribute},
		{"tdutil.ci_hint_rule", config.ciHintRule},
	} {
		if strings.ContainsAny(name.value, " \t\"'`") {
			return tdutilConfig{}, fmt.Errorf("`%s` value `%s` is not a valid Buck identifier", name.key, name.value)
		}
	}

	matcher, err := newBuildFileMatcher(cells, audited)
	if err != nil {
		return tdutilConfig{}, err
	}
	config.buildFiles = matcher
	return config, nil
}

// newBuildFileMatcher resolves each internal cell's build file names, applying
// the same precedence buck2 does: `name_v2` verbatim if set, otherwise every
// `name` entry preceded by its `.v2` sibling, otherwise the built-in default.
// `extra_for_test` is appended when present, because a repository which uses it
// really does have packages in those files and missing them under-selects.
func newBuildFileMatcher(cells cellMap, audited map[string]map[string]string) (buildFileMatcher, error) {
	resolved := make([]cellBuildFiles, 0, len(cells.cells))
	for cell, root := range cells.cells {
		section := audited[cell]
		var names []string
		switch {
		case configHas(section, "buildfile.name_v2"):
			names = configList(section, "buildfile.name_v2")
		case configHas(section, "buildfile.name"):
			for _, name := range configList(section, "buildfile.name") {
				names = append(names, name+".v2", name)
			}
		default:
			names = slices.Clone(defaultBuildFileNames)
		}
		if extra := configString(section, "buildfile.extra_for_test", ""); extra != "" {
			names = append(names, extra)
		}
		if len(names) == 0 {
			return buildFileMatcher{}, fmt.Errorf("cell `%s` configures an empty `buildfile.name`", cell)
		}
		resolved = append(resolved, cellBuildFiles{root: root, names: names})
	}
	// Longest root first so that a nested cell wins over the cell containing
	// it; the root cell's empty root sorts last and catches the remainder. The
	// name tiebreak only exists to keep the digest stable.
	sort.Slice(resolved, func(i, j int) bool {
		if len(resolved[i].root) != len(resolved[j].root) {
			return len(resolved[i].root) > len(resolved[j].root)
		}
		return resolved[i].root < resolved[j].root
	})
	return buildFileMatcher{cells: resolved}, nil
}

func configHas(section map[string]string, key string) bool {
	_, ok := section[key]
	return ok
}

func configString(section map[string]string, key, fallback string) string {
	value, ok := section[key]
	if !ok {
		return fallback
	}
	if value = strings.TrimSpace(value); value == "" {
		return fallback
	}
	return value
}

// configList reads a buckconfig list, which buck2 spells comma-separated.
func configList(section map[string]string, key string) []string {
	raw, ok := section[key]
	if !ok {
		return nil
	}
	result := make([]string, 0, 4)
	for _, item := range strings.Split(raw, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}

// normalizeConfigPaths puts configured paths into the same shape as the
// repository-relative paths they are compared against, and orders them so the
// configuration digest does not depend on how they were written.
func normalizeConfigPaths(paths []string) []string {
	if len(paths) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		path = strings.Trim(strings.ReplaceAll(path, "\\", "/"), "/")
		if path != "" {
			seen[path] = struct{}{}
		}
	}
	return sortedSet(seen)
}
