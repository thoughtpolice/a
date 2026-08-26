// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// This module supplies the real commit interval needed by flake-aware culprit
// finding. Epochs are sampling milestones, not commits: the agent enumerates
// every immutable JJ commit between a passing and failing milestone, then
// asks tdutil which adjacent changes affect the particular test. Nonlinear,
// ambiguous, and oversized histories fail closed instead of silently dropping
// suspects. Only the explicitly fake backend invents hermetic fixture commits.
package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

const maximumCulpritSuspects = 128

// culpritPlanner is an optional extension of the epoch-planning adapter.
type culpritPlanner interface {
	PlanCulprit(context.Context, job) (culpritPlan, error)
}

// culpritPlan is the versioned, ordered coverage artifact consumed by FACF.
// BaseRevision is excluded and Revision is included in Suspects.
type culpritPlan struct {
	Version      int              `json:"version"`
	BaseRevision string           `json:"base_revision"`
	Revision     string           `json:"revision"`
	TestKey      string           `json:"test_key"`
	Suspects     []culpritSuspect `json:"suspects"`
}

// culpritSuspect retains dependency relevance separately from direct test
// changes, because direct changes delimit the lifetime of flake evidence.
type culpritSuspect struct {
	Revision    string `json:"revision"`
	Affected    bool   `json:"affected"`
	TestChanged bool   `json:"test_changed"`
}

// PlanCulprit resolves a linear source interval without moving the anchor
// checkout. Each tdutil invocation uses the existing revision-workspace adapter
// and shares one overall planning timeout, including all graph comparisons.
func (planner tdutilManifestPlanner) PlanCulprit(ctx context.Context, claimed job) (culpritPlan, error) {
	test, err := validateCulpritJob(claimed)
	if err != nil {
		return culpritPlan{}, err
	}
	if claimed.Platform != planner.platform {
		return culpritPlan{}, fmt.Errorf("culprit platform %q does not match planner platform %q", claimed.Platform, planner.platform)
	}
	_, expectedKey := stableTestIdentity(claimed.Platform, test.Label)
	if test.TestKey != expectedKey {
		return culpritPlan{}, errors.New("culprit test identity does not match its target and platform")
	}
	ctx, cancel := context.WithTimeout(ctx, planner.timeout)
	defer cancel()
	directory := ""
	if planner.workspaces != nil {
		anchor, ok := planner.workspaces.(interface{ Directory() string })
		if !ok {
			return culpritPlan{}, errors.New("culprit planning requires a readable JJ anchor directory")
		}
		directory = anchor.Directory()
	}
	jjCommand := planner.jjCommand
	if jjCommand == "" {
		jjCommand = "jj"
	}
	baseCommit, commits, err := enumerateCulpritCommits(ctx, jjCommand, directory, *claimed.BaseRevision, claimed.Revision, planner.runJJCommand)
	if err != nil {
		return culpritPlan{}, err
	}
	if baseCommit != *claimed.BaseRevision || commits[len(commits)-1] != claimed.Revision {
		return culpritPlan{}, errors.New("real culprit jobs must name full immutable commit IDs, not revsets or abbreviated IDs")
	}
	plan := culpritPlan{
		Version: 1, BaseRevision: *claimed.BaseRevision,
		Revision: claimed.Revision, TestKey: test.TestKey,
		Suspects: make([]culpritSuspect, 0, len(commits)),
	}
	previous := baseCommit
	for _, commit := range commits {
		manifest, err := planner.Plan(ctx, &previous, commit)
		if err != nil {
			return culpritPlan{}, fmt.Errorf("plan culprit interval %s..%s: %w", previous, commit, err)
		}
		if manifest.BaseCommit != previous || manifest.RevisionCommit != commit {
			return culpritPlan{}, errors.New("tdutil resolved a culprit interval to different immutable commits")
		}
		suspect := culpritSuspect{Revision: commit}
		for _, affected := range manifest.Tests {
			if affected.Label != test.Label && affected.TestKey != test.TestKey {
				continue
			}
			if affected.Label != test.Label || affected.TestKey != test.TestKey || affected.Platform != claimed.Platform {
				return culpritPlan{}, errors.New("tdutil changed the culprit test's target identity")
			}
			if affected.Changed == nil {
				return culpritPlan{}, errors.New("tdutil omitted direct-change provenance for the culprit test")
			}
			suspect.Affected = true
			suspect.TestChanged = *affected.Changed
		}
		plan.Suspects = append(plan.Suspects, suspect)
		previous = commit
	}
	return plan, nil
}

// validateCulpritJob accepts exactly one test and a nonempty passing interval.
func validateCulpritJob(claimed job) (plannedTest, error) {
	if claimed.Kind != "plan_culprit" || claimed.BaseRevision == nil || strings.TrimSpace(*claimed.BaseRevision) == "" || strings.TrimSpace(claimed.Revision) == "" {
		return plannedTest{}, errors.New("culprit planning requires a passing base and failing revision")
	}
	if *claimed.BaseRevision == claimed.Revision {
		return plannedTest{}, errors.New("culprit interval must contain a source change")
	}
	if len(claimed.Tests) != 1 || claimed.Tests[0].Label == "" || claimed.Tests[0].TestKey == "" || claimed.Platform == "" {
		return plannedTest{}, errors.New("culprit planning requires exactly one identified test and platform")
	}
	return claimed.Tests[0], nil
}

// enumerateCulpritCommits returns a complete oldest-first single-parent chain.
// JJ is always read with --ignore-working-copy, endpoint expressions must each
// resolve once, and only full hexadecimal IDs enter the bounded range revset.
func enumerateCulpritCommits(
	ctx context.Context,
	command, directory, baseRevision, revision string,
	runner sourceCommandRunner,
) (string, []string, error) {
	if runner == nil {
		runner = runSourceCommand
	}
	read := func(revset, template string) ([]byte, error) {
		stdout, stderr, err := runner(ctx, command, []string{
			"--no-pager", "--color=never", "--ignore-working-copy",
			"log", "--no-graph", "--revisions", revset, "--template", template,
		}, directory)
		if err != nil {
			return nil, sourceCommandError("read culprit commit history", err, stderr)
		}
		return stdout, nil
	}
	resolve := func(revision string) (string, error) {
		output, err := read(revision, `commit_id ++ "\n"`)
		if err != nil {
			return "", err
		}
		fields := strings.Fields(string(output))
		if len(fields) != 1 || !isFullCommitID(fields[0]) {
			return "", fmt.Errorf("culprit revision %q must resolve to exactly one full immutable commit ID", revision)
		}
		return fields[0], nil
	}
	base, err := resolve(baseRevision)
	if err != nil {
		return "", nil, err
	}
	head, err := resolve(revision)
	if err != nil {
		return "", nil, err
	}
	if base == head {
		return "", nil, errors.New("culprit endpoints resolve to the same commit")
	}
	revset := fmt.Sprintf("latest((%s..%s), %d)", base, head, maximumCulpritSuspects+1)
	output, err := read(revset, `commit_id ++ " " ++ parents.map(|p| p.commit_id()).join(" ") ++ "\n"`)
	if err != nil {
		return "", nil, err
	}
	parents := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(string(output)), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || !isFullCommitID(fields[0]) || !isFullCommitID(fields[1]) {
			return "", nil, errors.New("culprit interval is empty, malformed, or non-linear (merge/root commit)")
		}
		if _, duplicate := parents[fields[0]]; duplicate {
			return "", nil, errors.New("JJ returned a duplicate culprit commit")
		}
		parents[fields[0]] = fields[1]
		if len(parents) > maximumCulpritSuspects {
			return "", nil, fmt.Errorf("culprit interval exceeds %d commits", maximumCulpritSuspects)
		}
	}
	reversed := make([]string, 0, len(parents))
	seen := make(map[string]bool)
	for cursor := head; cursor != base; {
		parent, found := parents[cursor]
		if !found || seen[cursor] {
			return "", nil, errors.New("passing base is not the ancestor of one complete linear culprit interval")
		}
		seen[cursor] = true
		reversed = append(reversed, cursor)
		cursor = parent
	}
	if len(reversed) != len(parents) {
		return "", nil, errors.New("culprit interval contains commits outside the linear passing-to-failing chain")
	}
	commits := make([]string, len(reversed))
	for index, commit := range reversed {
		commits[len(reversed)-1-index] = commit
	}
	return base, commits, nil
}

// isFullCommitID forbids abbreviated IDs and revset syntax in generated ranges.
func isFullCommitID(value string) bool {
	return (len(value) == 40 || len(value) == 64) && isHexCommit(value) && value == strings.ToLower(value)
}

// PlanCulprit supplies a deterministic three-commit interval only in fake mode.
// Its middle commit is unrelated, exercising tdutil-based suspect pruning.
func (fakeManifestPlanner) PlanCulprit(_ context.Context, claimed job) (culpritPlan, error) {
	test, err := validateCulpritJob(claimed)
	if err != nil {
		return culpritPlan{}, err
	}
	return culpritPlan{
		Version: 1, BaseRevision: *claimed.BaseRevision,
		Revision: claimed.Revision, TestKey: test.TestKey,
		Suspects: []culpritSuspect{
			{Revision: claimed.Revision + "-fake-candidate-1", Affected: true},
			{Revision: claimed.Revision + "-fake-candidate-2", Affected: false},
			{Revision: claimed.Revision, Affected: true},
		},
	}, nil
}
