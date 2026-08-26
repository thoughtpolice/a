// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// These tests pin complete commit enumeration and adjacent tdutil provenance
// independently of any live repository, and keep the fake path visibly fake.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestCulpritEnumerationReturnsEveryImmutableCommitInOrder(t *testing.T) {
	t.Parallel()
	base, first, second, head := culpritCommitID(1), culpritCommitID(2), culpritCommitID(3), culpritCommitID(4)
	history := fmt.Sprintf("%s %s\n%s %s\n%s %s\n", head, second, first, base, second, first)
	runner := culpritHistoryRunner(t, base, head, history)
	resolved, commits, err := enumerateCulpritCommits(context.Background(), "jj", "/cache/anchor", "passing", "failing", runner)
	if err != nil || resolved != base || !reflect.DeepEqual(commits, []string{first, second, head}) {
		t.Fatalf("base=%s commits=%v err=%v", resolved, commits, err)
	}
}

func TestCulpritEnumerationRejectsIncompleteAndNonlinearHistory(t *testing.T) {
	t.Parallel()
	base, first, side, head := culpritCommitID(1), culpritCommitID(2), culpritCommitID(3), culpritCommitID(4)
	tests := map[string]string{
		"merge":                fmt.Sprintf("%s %s %s\n%s %s\n%s %s\n", head, first, side, first, base, side, base),
		"nonancestor":          fmt.Sprintf("%s %s\n", head, side),
		"missing intermediate": fmt.Sprintf("%s %s\n%s %s\n", head, side, first, base),
		"unrelated node":       fmt.Sprintf("%s %s\n%s %s\n%s %s\n", head, first, first, base, side, base),
		"duplicate":            fmt.Sprintf("%s %s\n%s %s\n", head, base, head, base),
		"cycle":                fmt.Sprintf("%s %s\n%s %s\n", head, first, first, head),
		"root":                 head + "\n",
		"empty":                "",
		"malformed":            "short short\n",
	}
	for name, history := range tests {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			_, _, err := enumerateCulpritCommits(context.Background(), "jj", "/cache/anchor", "passing", "failing", culpritHistoryRunner(t, base, head, history))
			if err == nil {
				t.Fatal("accepted incomplete/nonlinear culprit interval")
			}
		})
	}
}

func TestCulpritEnumerationCapsTheCompleteInterval(t *testing.T) {
	t.Parallel()
	for _, count := range []int{maximumCulpritSuspects, maximumCulpritSuspects + 1} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			t.Parallel()
			var history strings.Builder
			for index := 1; index <= count; index++ {
				fmt.Fprintf(&history, "%s %s\n", culpritCommitID(index+1), culpritCommitID(index))
			}
			_, commits, err := enumerateCulpritCommits(context.Background(), "jj", "/cache/anchor", "passing", "failing", culpritHistoryRunner(t, culpritCommitID(1), culpritCommitID(count+1), history.String()))
			if count > maximumCulpritSuspects {
				if err == nil || !strings.Contains(err.Error(), "exceeds") {
					t.Fatalf("error=%v", err)
				}
			} else if err != nil || len(commits) != count {
				t.Fatalf("commits=%d err=%v", len(commits), err)
			}
		})
	}
}

func TestCulpritEnumerationRejectsAmbiguousOrMutableEndpoints(t *testing.T) {
	t.Parallel()
	for _, output := range []string{"", "short\n", culpritCommitID(1) + "\n" + culpritCommitID(2) + "\n", strings.Repeat("A", 40) + "\n"} {
		runner := func(context.Context, string, []string, string) ([]byte, []byte, error) {
			return []byte(output), nil, nil
		}
		if _, _, err := enumerateCulpritCommits(context.Background(), "jj", "", "passing", "failing", runner); err == nil {
			t.Fatalf("accepted endpoint output %q", output)
		}
	}
}

func TestCulpritEnumerationReportsJJFailure(t *testing.T) {
	t.Parallel()
	runner := func(context.Context, string, []string, string) ([]byte, []byte, error) {
		return nil, []byte("commit not fetched"), errors.New("exit 1")
	}
	if _, _, err := enumerateCulpritCommits(context.Background(), "jj", "", "passing", "failing", runner); err == nil || !strings.Contains(err.Error(), "commit not fetched") {
		t.Fatalf("error=%v", err)
	}
}

func TestCulpritPlannerUsesAdjacentTDUtilIntervals(t *testing.T) {
	t.Parallel()
	base, first, second, head := culpritCommitID(1), culpritCommitID(2), culpritCommitID(3), culpritCommitID(4)
	history := fmt.Sprintf("%s %s\n%s %s\n%s %s\n", head, second, second, first, first, base)
	label := "root//pkg:unit_test"
	_, key := stableTestIdentity("linux-x86_64", label)
	baseRevision := base
	intervals := [][2]string{}
	planner := tdutilManifestPlanner{
		command: "tdutil", jjCommand: "jj", platform: "linux-x86_64",
		initialBase: "root()", universes: []string{"root//..."}, timeout: time.Minute,
		runJJCommand: culpritHistoryRunner(t, base, head, history),
		runCommand: func(ctx context.Context, command string, args []string, directory string) ([]byte, []byte, error) {
			if _, bounded := ctx.Deadline(); !bounded {
				t.Fatal("culprit graph comparison has no aggregate deadline")
			}
			from, to := argumentAfter(t, args, "--from"), argumentAfter(t, args, "--to")
			intervals = append(intervals, [2]string{from, to})
			targets := []tdutilTarget{}
			if to == first {
				dependency := "root//pkg:lib"
				targets = append(targets, tdutilTarget{Target: label, RuleType: "go_test", Depth: 1, Reason: "dependency changed", AffectedDep: &dependency})
			}
			if to == head {
				targets = append(targets, tdutilTarget{Target: label, RuleType: "go_test", Depth: 0, Reason: "test changed"})
			}
			encoded, err := json.Marshal(tdutilDocument{
				Base: from, Head: to, BaseCommit: from, HeadCommit: to,
				Universe: []string{"root//..."}, Count: len(targets), Targets: targets,
			})
			return encoded, nil, err
		},
	}
	plan, err := planner.PlanCulprit(context.Background(), job{
		Kind: "plan_culprit", BaseRevision: &baseRevision, Revision: head, Platform: "linux-x86_64",
		Tests: []plannedTest{{ID: "epoch-local-id", TestKey: key, Label: label}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(intervals, [][2]string{{base, first}, {first, second}, {second, head}}) {
		t.Fatalf("tdutil intervals=%v", intervals)
	}
	want := []culpritSuspect{
		{Revision: first, Affected: true},
		{Revision: second, Affected: false},
		{Revision: head, Affected: true, TestChanged: true},
	}
	if plan.Version != 1 || plan.BaseRevision != base || plan.Revision != head || plan.TestKey != key || !reflect.DeepEqual(plan.Suspects, want) {
		t.Fatalf("plan=%+v", plan)
	}
}

func TestCulpritPlannerRejectsIdentityMismatchBeforeReadingSource(t *testing.T) {
	t.Parallel()
	base := "passing"
	planner := tdutilManifestPlanner{platform: "linux-x86_64"}
	_, err := planner.PlanCulprit(context.Background(), job{
		Kind: "plan_culprit", BaseRevision: &base, Revision: "failing", Platform: "linux-x86_64",
		Tests: []plannedTest{{ID: "id", TestKey: "wrong", Label: "root//pkg:test"}},
	})
	if err == nil || !strings.Contains(err.Error(), "identity") {
		t.Fatalf("error=%v", err)
	}
}

func TestRealCulpritPlannerRejectsMutableJobIdentity(t *testing.T) {
	t.Parallel()
	base, head := culpritCommitID(1), culpritCommitID(2)
	baseRevision := "passing"
	_, key := stableTestIdentity("linux-x86_64", "root//pkg:test")
	planner := tdutilManifestPlanner{
		platform: "linux-x86_64", timeout: time.Minute,
		runJJCommand: culpritHistoryRunner(t, base, head, head+" "+base+"\n"),
	}
	_, err := planner.PlanCulprit(context.Background(), job{
		Kind: "plan_culprit", BaseRevision: &baseRevision, Revision: "failing", Platform: "linux-x86_64",
		Tests: []plannedTest{{ID: "t1", TestKey: key, Label: "root//pkg:test"}},
	})
	if err == nil || !strings.Contains(err.Error(), "full immutable") {
		t.Fatalf("error=%v", err)
	}
}

func TestFakeCulpritPlannerIsDeterministicAndUsesJobProtocol(t *testing.T) {
	t.Parallel()
	base := "fake-base"
	claimed := job{
		Kind: "plan_culprit", BaseRevision: &base, Revision: "fake-failure", Platform: "linux-x86_64",
		Tests: []plannedTest{{ID: "t1", TestKey: "fake-test", Label: "root//pkg:test"}},
	}
	first, err := jobResult(context.Background(), claimed, fakeManifestPlanner{}, fakeTestExecutor{}, io.Discard)
	if err != nil {
		t.Fatal(err)
	}
	second, err := jobResult(context.Background(), claimed, fakeManifestPlanner{}, fakeTestExecutor{}, io.Discard)
	if err != nil || !reflect.DeepEqual(first, second) {
		t.Fatalf("nondeterministic fake culprit result: %v", err)
	}
	encoded, _ := json.Marshal(first)
	var result struct {
		Kind string      `json:"kind"`
		Plan culpritPlan `json:"plan"`
	}
	json.Unmarshal(encoded, &result)
	if result.Kind != "plan_culprit" || len(result.Plan.Suspects) != 3 || result.Plan.Suspects[1].Affected || result.Plan.Suspects[2].Revision != claimed.Revision {
		t.Fatalf("result=%+v", result)
	}
}

func TestCulpritJobRequiresOneTestAndAPassingBase(t *testing.T) {
	t.Parallel()
	base := "r1"
	for _, claimed := range []job{
		{},
		{Kind: "plan_culprit", Revision: "r2"},
		{Kind: "plan_culprit", BaseRevision: &base, Revision: "r1"},
		{Kind: "plan_culprit", BaseRevision: &base, Revision: "r2", Platform: "linux-x86_64"},
		{Kind: "plan_culprit", BaseRevision: &base, Revision: "r2", Platform: "linux-x86_64", Tests: []plannedTest{{Label: "t", TestKey: "k"}, {Label: "t2", TestKey: "k2"}}},
	} {
		if _, err := (fakeManifestPlanner{}).PlanCulprit(context.Background(), claimed); err == nil {
			t.Fatalf("accepted invalid culprit job: %+v", claimed)
		}
	}
}

func culpritCommitID(index int) string {
	return fmt.Sprintf("%040x", index)
}

// culpritHistoryRunner accepts only read-only JJ calls and checks the bounded
// revset uses resolved commit IDs, not caller-controlled endpoint expressions.
func culpritHistoryRunner(t *testing.T, base, head, history string) sourceCommandRunner {
	t.Helper()
	return func(_ context.Context, command string, args []string, directory string) ([]byte, []byte, error) {
		if command != "jj" || !containsArgument(args, "--ignore-working-copy") || !containsArgument(args, "--no-graph") {
			t.Fatalf("unsafe JJ command %s %v", command, args)
		}
		if directory != "" && directory != "/cache/anchor" {
			t.Fatalf("unexpected anchor directory %q", directory)
		}
		switch argumentAfter(t, args, "--revisions") {
		case "passing", base:
			return []byte(base + "\n"), nil, nil
		case "failing", head:
			return []byte(head + "\n"), nil, nil
		case fmt.Sprintf("latest((%s..%s), %d)", base, head, maximumCulpritSuspects+1):
			return []byte(history), nil, nil
		default:
			t.Fatalf("unexpected JJ range %v", args)
			return nil, nil, errors.New("unexpected JJ arguments")
		}
	}
}
