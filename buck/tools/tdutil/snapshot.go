// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"
)

// A snapshot document is the base endpoint of the two-snapshot protocol,
// captured once and reused across runs and machines. Everything in it is
// workspace-independent: cell roots are repository-relative, and targets,
// files, and diagnostics are recorded in their cell-qualified and
// repository-relative forms. The document also records everything its graph
// depended on — commit, universe, Buck configuration arguments, the
// repository-local Buck config digest, and the exact buck2 version — so a
// reader can prove the snapshot describes the base it needs. Any mismatch
// falls back to full collection rather than trusting a stale graph.
const snapshotSchemaVersion = 1

type snapshotDocument struct {
	Schema            int               `json:"schema"`
	TdutilVersion     string            `json:"tdutil_version"`
	BuckVersion       string            `json:"buck_version"`
	Commit            string            `json:"commit"`
	Universe          []string          `json:"universe"`
	BuckArgs          []string          `json:"buck_args"`
	LocalConfigSHA256 string            `json:"local_config_sha256"`
	Cells             map[string]string `json:"cells"`
	ExternalCells     []string          `json:"external_cells"`
	Targets           []documentTarget  `json:"targets"`
	Files             []documentFile    `json:"files"`
	Errors            []documentError   `json:"errors"`
}

type documentTarget struct {
	Label           string   `json:"label"`
	Name            string   `json:"name"`
	Package         string   `json:"package"`
	RepoPackage     string   `json:"repo_package"`
	RuleType        string   `json:"rule_type"`
	Deps            []string `json:"deps"`
	Inputs          []string `json:"inputs"`
	CellInputs      []string `json:"cell_inputs"`
	TargetHash      string   `json:"target_hash"`
	Labels          []string `json:"labels"`
	CiSrcs          []string `json:"ci_srcs"`
	CiSrcsMustMatch []string `json:"ci_srcs_must_match"`
	CiDeps          []string `json:"ci_deps"`
}

type documentFile struct {
	CellPath    string   `json:"cell_path"`
	Path        *string  `json:"path"`
	Package     *string  `json:"package"`
	RepoPackage *string  `json:"repo_package"`
	CellImports []string `json:"cell_imports"`
	Imports     []string `json:"imports"`
}

type documentError struct {
	Package     string   `json:"package"`
	Diagnostics []string `json:"diagnostics"`
}

func buildSnapshotDocument(
	buckVersion, commit string,
	universe, buckArgs []string,
	localConfigDigest string,
	collected *snapshot,
) *snapshotDocument {
	cells := make(map[string]string, len(collected.cells.cells))
	for name, root := range collected.cells.cells {
		cells[name] = root
	}
	external := make([]string, 0, len(collected.cells.externalCells))
	for name := range collected.cells.externalCells {
		external = append(external, name)
	}
	sort.Strings(external)

	targets := make([]documentTarget, 0, len(collected.targets))
	for _, label := range sortedTargetLabels(collected.targets) {
		record := collected.targets[label]
		targets = append(targets, documentTarget{
			Label:           record.label,
			Name:            record.name,
			Package:         record.packageName,
			RepoPackage:     record.repoPackage,
			RuleType:        record.ruleType,
			Deps:            record.deps,
			Inputs:          record.inputs,
			CellInputs:      record.cellInputs,
			TargetHash:      record.targetHash,
			Labels:          record.labels,
			CiSrcs:          record.ciSrcs,
			CiSrcsMustMatch: record.ciSrcsMustMatch,
			CiDeps:          record.ciDeps,
		})
	}

	filePaths := make([]string, 0, len(collected.files))
	for cellPath := range collected.files {
		filePaths = append(filePaths, cellPath)
	}
	sort.Strings(filePaths)
	files := make([]documentFile, 0, len(filePaths))
	for _, cellPath := range filePaths {
		record := collected.files[cellPath]
		files = append(files, documentFile{
			CellPath:    record.cellPath,
			Path:        record.path,
			Package:     record.packageName,
			RepoPackage: record.repoPackage,
			CellImports: record.cellImports,
			Imports:     record.imports,
		})
	}

	errorPackages := make([]string, 0, len(collected.errors))
	for packageName := range collected.errors {
		errorPackages = append(errorPackages, packageName)
	}
	sort.Strings(errorPackages)
	diagnostics := make([]documentError, 0, len(errorPackages))
	for _, packageName := range errorPackages {
		diagnostics = append(diagnostics, documentError{
			Package:     packageName,
			Diagnostics: collected.errors[packageName],
		})
	}

	return &snapshotDocument{
		Schema:            snapshotSchemaVersion,
		TdutilVersion:     tdutilVersion,
		BuckVersion:       buckVersion,
		Commit:            commit,
		Universe:          append([]string{}, universe...),
		BuckArgs:          append([]string{}, buckArgs...),
		LocalConfigSHA256: localConfigDigest,
		Cells:             cells,
		ExternalCells:     external,
		Targets:           targets,
		Files:             files,
		Errors:            diagnostics,
	}
}

// quotedOrAbsent describes a recorded version for a diagnostic. A document
// written before the version was recorded decodes to the empty string rather
// than to a version anyone can act on.
func quotedOrAbsent(version string) string {
	if version == "" {
		return "an unrecorded version"
	}
	return version
}

func encodeSnapshotDocument(document *snapshotDocument) ([]byte, error) {
	data, err := json.Marshal(document)
	if err != nil {
		return nil, fmt.Errorf("encoding base snapshot: %w", err)
	}
	return append(data, '\n'), nil
}

func parseSnapshotDocument(data []byte) (*snapshotDocument, error) {
	if !utf8.Valid(data) {
		return nil, fmt.Errorf("malformed base snapshot: input is not UTF-8")
	}
	// Probe the schema first so a future schema reports as such instead of as
	// an unknown-field decoding failure.
	var probe struct {
		Schema int `json:"schema"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return nil, fmt.Errorf("malformed base snapshot: %w", err)
	}
	if probe.Schema != snapshotSchemaVersion {
		return nil, fmt.Errorf("base snapshot schema %d is not supported (want %d)", probe.Schema, snapshotSchemaVersion)
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var document snapshotDocument
	if err := decoder.Decode(&document); err != nil {
		return nil, fmt.Errorf("malformed base snapshot: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, fmt.Errorf("malformed base snapshot: trailing data after the document")
	}

	if document.Commit == "" {
		return nil, fmt.Errorf("base snapshot has no commit")
	}
	for index := 0; index < len(document.Commit); index++ {
		char := document.Commit[index]
		if !((char >= '0' && char <= '9') || (char >= 'a' && char <= 'f') || (char >= 'A' && char <= 'F')) {
			return nil, fmt.Errorf("base snapshot has a malformed commit ID %q", document.Commit)
		}
	}
	if len(document.Universe) == 0 {
		return nil, fmt.Errorf("base snapshot has no universe patterns")
	}
	return &document, nil
}

// mismatchReason explains why the document cannot stand in for the requested
// base endpoint, or returns the empty string when every recorded input
// matches. The buck2 version is checked separately so callers can defer that
// subprocess until everything cheaper has passed.
func (document *snapshotDocument) mismatchReason(
	baseCommit string,
	universe, buckArgs []string,
	localConfigDigest string,
) string {
	// Checked first: a tdutil mismatch invalidates the document wholesale,
	// including the meaning of everything compared below.
	if document.TdutilVersion != tdutilVersion {
		return fmt.Sprintf(
			"snapshot was made by tdutil %s but this is tdutil %s",
			quotedOrAbsent(document.TdutilVersion),
			tdutilVersion,
		)
	}
	if document.Commit != baseCommit {
		return fmt.Sprintf("snapshot is for commit %s, not base %s", document.Commit, baseCommit)
	}
	if !slices.Equal(document.Universe, universe) {
		return "universe patterns differ"
	}
	if !slices.Equal(document.BuckArgs, buckArgs) {
		return "Buck configuration arguments differ"
	}
	if document.LocalConfigSHA256 != localConfigDigest {
		return "the repository-local Buck config differs"
	}
	return ""
}

func (document *snapshotDocument) toSnapshot() (snapshot, error) {
	cells := make(map[string]string, len(document.Cells))
	for name, root := range document.Cells {
		if name == "" || strings.Contains(name, "//") {
			return snapshot{}, fmt.Errorf("base snapshot has an invalid cell name %q", name)
		}
		cells[name] = root
	}
	external := make(map[string]string, len(document.ExternalCells))
	for _, name := range document.ExternalCells {
		if name == "" || strings.Contains(name, "//") {
			return snapshot{}, fmt.Errorf("base snapshot has an invalid external cell name %q", name)
		}
		if _, duplicate := cells[name]; duplicate {
			return snapshot{}, fmt.Errorf("base snapshot lists cell %q as both internal and external", name)
		}
		external[name] = ""
	}
	if len(cells)+len(external) == 0 {
		return snapshot{}, fmt.Errorf("base snapshot has no cells")
	}

	result := emptySnapshot(assembleCellMap(cells, external))
	for _, record := range document.Targets {
		if record.Label == "" {
			return snapshot{}, fmt.Errorf("base snapshot has a target without a label")
		}
		if _, duplicate := result.targets[record.Label]; duplicate {
			return snapshot{}, fmt.Errorf("base snapshot has duplicate target %q", record.Label)
		}
		result.targets[record.Label] = target{
			label:           record.Label,
			name:            record.Name,
			packageName:     record.Package,
			repoPackage:     record.RepoPackage,
			ruleType:        record.RuleType,
			deps:            record.Deps,
			inputs:          record.Inputs,
			cellInputs:      record.CellInputs,
			targetHash:      record.TargetHash,
			labels:          record.Labels,
			ciSrcs:          record.CiSrcs,
			ciSrcsMustMatch: record.CiSrcsMustMatch,
			ciDeps:          record.CiDeps,
		}
	}
	for _, record := range document.Files {
		if record.CellPath == "" {
			return snapshot{}, fmt.Errorf("base snapshot has a file record without a path")
		}
		if _, duplicate := result.files[record.CellPath]; duplicate {
			return snapshot{}, fmt.Errorf("base snapshot has duplicate file record %q", record.CellPath)
		}
		result.files[record.CellPath] = fileNode{
			cellPath:    record.CellPath,
			path:        record.Path,
			packageName: record.Package,
			repoPackage: record.RepoPackage,
			cellImports: record.CellImports,
			imports:     record.Imports,
		}
	}
	for _, record := range document.Errors {
		if record.Package == "" {
			return snapshot{}, fmt.Errorf("base snapshot has an error record without a package")
		}
		if _, duplicate := result.errors[record.Package]; duplicate {
			return snapshot{}, fmt.Errorf("base snapshot has duplicate error records for %q", record.Package)
		}
		result.errors[record.Package] = record.Diagnostics
	}
	return result, nil
}

// loadBaseSnapshot returns a usable document, or nil plus the human-readable
// reason it cannot stand in for the base endpoint. Every reason means the
// caller falls back to full collection; a snapshot is never trusted past its
// recorded identity.
func loadBaseSnapshot(
	ctx context.Context,
	runner processRunner,
	path, buck, repository, baseCommit string,
	universe, buckArgs []string,
) (*snapshotDocument, string) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, "no snapshot file present"
		}
		return nil, err.Error()
	}
	document, err := parseSnapshotDocument(data)
	if err != nil {
		return nil, err.Error()
	}
	digest, err := localBuckConfigDigest(repository)
	if err != nil {
		return nil, err.Error()
	}
	if reason := document.mismatchReason(baseCommit, universe, buckArgs, digest); reason != "" {
		return nil, reason
	}
	version, err := buckVersionString(ctx, runner, buck)
	if err != nil {
		return nil, err.Error()
	}
	if version != document.BuckVersion {
		return nil, fmt.Sprintf("snapshot was made by buck2 %q but the current buck2 is %q", document.BuckVersion, version)
	}
	return document, ""
}

// localBuckConfigDigest identifies the repository-local Buck configuration
// which both endpoint graphs would observe. An absent file digests to the
// empty string.
func localBuckConfigDigest(repository string) (string, error) {
	config, err := snapshotBuckLocalConfig(repository)
	if err != nil {
		return "", err
	}
	if config == nil {
		return "", nil
	}
	return fmt.Sprintf("%x", sha256.Sum256(config.contents)), nil
}

func buckVersionString(ctx context.Context, runner processRunner, buck string) (string, error) {
	result, err := runner.run(ctx, commandSpec{path: buck, args: []string{"--version"}})
	if err != nil {
		return "", fmt.Errorf("failed to run `%s --version`: %w", buck, err)
	}
	if err := ensureBuckProcessSuccess("buck2 --version", result); err != nil {
		return "", err
	}
	if !utf8.Valid(result.stdout) {
		return "", fmt.Errorf("`buck2 --version` produced non-UTF-8 stdout")
	}
	version := strings.TrimSpace(string(result.stdout))
	if version == "" {
		return "", fmt.Errorf("`buck2 --version` produced no version")
	}
	return version, nil
}

// planUniverseCachedBase plans the universe when the base graph comes from a
// snapshot. Every requested pattern was queried when the snapshot was made —
// capture fails outright on patterns without evidence — so the base side is
// unconditional evidence and only the head tree is inspected.
func planUniverseCachedBase(headWorkspace string, headCells cellMap, patterns []string) (universePlan, error) {
	plan := universePlan{patterns: make([]plannedPattern, 0, len(patterns))}
	for _, raw := range patterns {
		kind := classifyPattern(raw)
		packageName, classified := patternPackage(kind)
		if !classified {
			plan.headPatterns = append(plan.headPatterns, raw)
			plan.patterns = append(plan.patterns, plannedPattern{raw: raw, kind: kind, base: true, head: true})
			continue
		}
		headState, err := inspectAnchor(headWorkspace, headCells, packageName)
		if err != nil {
			return universePlan{}, err
		}
		headEvidence := headState == anchorPresent || headState == anchorExternal
		if headEvidence {
			plan.headPatterns = append(plan.headPatterns, raw)
		}
		plan.patterns = append(plan.patterns, plannedPattern{raw: raw, kind: kind, base: true, head: headEvidence})
	}
	return plan, nil
}

// collectSnapshotPairFromDocument stands the recorded base graph next to a
// freshly collected head graph, with the same universe validation as the
// two-workspace path.
func collectSnapshotPairFromDocument(
	ctx context.Context,
	runner processRunner,
	document *snapshotDocument,
	headWorkspace, buck string,
	buckArgs []string,
	isolation string,
	patterns []string,
) (snapshot, snapshot, universePlan, error) {
	if len(patterns) == 0 {
		return snapshot{}, snapshot{}, universePlan{}, fmt.Errorf("at least one Buck target pattern is required")
	}
	base, err := document.toSnapshot()
	if err != nil {
		return snapshot{}, snapshot{}, universePlan{}, err
	}
	headCells, err := auditCells(ctx, runner, headWorkspace, buck, buckArgs, isolation)
	if err != nil {
		return snapshot{}, snapshot{}, universePlan{}, err
	}
	plan, err := planUniverseCachedBase(headWorkspace, headCells, patterns)
	if err != nil {
		return snapshot{}, snapshot{}, universePlan{}, err
	}
	head, err := collectTargets(ctx, runner, headWorkspace, buck, buckArgs, isolation, plan.headPatterns, headCells)
	if err != nil {
		return snapshot{}, snapshot{}, universePlan{}, err
	}
	if err := validateUniverse(&plan, &base, &head); err != nil {
		return snapshot{}, snapshot{}, universePlan{}, err
	}
	return base, head, plan, nil
}
