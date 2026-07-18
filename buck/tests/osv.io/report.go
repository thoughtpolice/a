// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"fmt"
	"io"
	"sort"
	"strings"
)

type advisoryGroup struct {
	Primary         string
	Aliases         []string
	Summary         string
	ExceptionIDs    []string
	ExceptionReason string
}

type finding struct {
	Subject subject
	Groups  []advisoryGroup
}

func analyzeFindings(subjects []subject, queryResults [][]vulnerabilityRef, details map[string]vulnerability) ([]finding, error) {
	if len(subjects) != len(queryResults) {
		return nil, fmt.Errorf("internal error: %d subjects have %d query results", len(subjects), len(queryResults))
	}
	findings := make([]finding, 0)
	for index, item := range subjects {
		groups, err := groupAdvisories(item.Kind, queryResults[index], details)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", item.Name, err)
		}
		if len(groups) > 0 {
			findings = append(findings, finding{Subject: item, Groups: groups})
		}
	}
	sort.Slice(findings, func(left, right int) bool {
		return findings[left].Subject.Name < findings[right].Subject.Name
	})
	return findings, nil
}

func groupAdvisories(kind subjectKind, references []vulnerabilityRef, details map[string]vulnerability) ([]advisoryGroup, error) {
	if len(references) == 0 {
		return nil, nil
	}
	type record struct {
		queryID string
		detail  vulnerability
	}
	records := make([]record, 0, len(references))
	seen := make(map[string]struct{})
	for _, reference := range references {
		if _, duplicate := seen[reference.ID]; duplicate {
			continue
		}
		seen[reference.ID] = struct{}{}
		detail, ok := details[reference.ID]
		if !ok {
			return nil, fmt.Errorf("missing details for %s", reference.ID)
		}
		// Withdrawn records no longer describe a vulnerability. OSV normally
		// filters these from queries, but honor the schema if one is returned.
		if detail.Withdrawn != "" {
			continue
		}
		records = append(records, record{queryID: reference.ID, detail: detail})
	}
	if len(records) == 0 {
		return nil, nil
	}

	parents := make([]int, len(records))
	for index := range parents {
		parents[index] = index
	}
	var find func(int) int
	find = func(value int) int {
		if parents[value] != value {
			parents[value] = find(parents[value])
		}
		return parents[value]
	}
	union := func(left, right int) {
		leftRoot, rightRoot := find(left), find(right)
		if leftRoot != rightRoot {
			parents[rightRoot] = leftRoot
		}
	}
	owner := make(map[string]int)
	for index, record := range records {
		identifiers := append([]string{record.queryID, record.detail.ID}, record.detail.Aliases...)
		for _, identifier := range identifiers {
			if identifier == "" {
				continue
			}
			if previous, ok := owner[identifier]; ok {
				union(index, previous)
			} else {
				owner[identifier] = index
			}
		}
	}

	grouped := make(map[int][]record)
	for index, record := range records {
		grouped[find(index)] = append(grouped[find(index)], record)
	}
	exceptionByID := make(map[string]string, len(rustExceptions))
	for _, item := range rustExceptions {
		exceptionByID[item.ID] = item.Reason
	}

	groups := make([]advisoryGroup, 0, len(grouped))
	for _, records := range grouped {
		identifierSet := make(map[string]struct{})
		for _, record := range records {
			identifierSet[record.queryID] = struct{}{}
			identifierSet[record.detail.ID] = struct{}{}
			for _, alias := range record.detail.Aliases {
				if alias != "" {
					identifierSet[alias] = struct{}{}
				}
			}
		}
		identifiers := make([]string, 0, len(identifierSet))
		for identifier := range identifierSet {
			if identifier != "" {
				identifiers = append(identifiers, identifier)
			}
		}
		sort.Slice(identifiers, func(left, right int) bool {
			return advisoryIDLess(identifiers[left], identifiers[right])
		})
		group := advisoryGroup{Primary: identifiers[0]}
		group.Aliases = append(group.Aliases, identifiers[1:]...)
		for _, record := range records {
			if record.detail.ID == group.Primary && record.detail.Summary != "" {
				group.Summary = record.detail.Summary
				break
			}
		}
		if group.Summary == "" {
			for _, record := range records {
				if record.detail.Summary != "" {
					group.Summary = record.detail.Summary
					break
				}
				if group.Summary == "" && record.detail.Details != "" {
					group.Summary = firstSentence(record.detail.Details)
				}
			}
		}
		if group.Summary == "" {
			group.Summary = "No summary provided"
		}
		if kind == rustSubject {
			var reasons []string
			for _, identifier := range identifiers {
				if reason, ok := exceptionByID[identifier]; ok {
					group.ExceptionIDs = append(group.ExceptionIDs, identifier)
					reasons = append(reasons, reason)
				}
			}
			group.ExceptionReason = strings.Join(reasons, "; ")
		}
		groups = append(groups, group)
	}
	sort.Slice(groups, func(left, right int) bool {
		return advisoryIDLess(groups[left].Primary, groups[right].Primary)
	})
	return groups, nil
}

func advisoryIDLess(left, right string) bool {
	priority := func(id string) int {
		switch {
		case strings.HasPrefix(id, "RUSTSEC-"):
			return 0
		case strings.HasPrefix(id, "GHSA-"):
			return 1
		case strings.HasPrefix(id, "CVE-"):
			return 2
		default:
			return 3
		}
	}
	leftPriority, rightPriority := priority(left), priority(right)
	if leftPriority != rightPriority {
		return leftPriority < rightPriority
	}
	return left < right
}

func firstSentence(value string) string {
	value = strings.Join(strings.Fields(value), " ")
	if end := strings.Index(value, ". "); end >= 0 {
		value = value[:end+1]
	}
	if len(value) > 240 {
		value = value[:237] + "..."
	}
	return value
}

// writeReport returns true when an unexcepted advisory should fail the check.
func writeReport(w io.Writer, subjects []subject, findings []finding) bool {
	affected := len(findings)
	clean := len(subjects) - affected
	hasRust := false
	for _, item := range subjects {
		if item.Kind == rustSubject {
			hasRust = true
			break
		}
	}
	groupCount := 0
	exemptGroupCount := 0
	violationGroupCount := 0
	usedExceptions := make(map[string]struct{})

	for _, item := range findings {
		hasViolation := false
		for _, group := range item.Groups {
			groupCount++
			if group.ExceptionReason == "" {
				violationGroupCount++
				hasViolation = true
			} else {
				exemptGroupCount++
				for _, id := range group.ExceptionIDs {
					usedExceptions[id] = struct{}{}
				}
			}
		}
		status := "EXEMPT"
		if hasViolation {
			status = "FAIL"
		}
		fmt.Fprintf(w, "\n[%s] %s\n", status, item.Subject.Name)
		fmt.Fprintf(w, "  %s\n", item.Subject.Display)
		for _, group := range item.Groups {
			marker := "BLOCKING"
			if group.ExceptionReason != "" {
				marker = "EXCEPTION"
			}
			fmt.Fprintf(w, "  - %s [%s]: %s\n", group.Primary, marker, group.Summary)
			if len(group.Aliases) > 0 {
				fmt.Fprintf(w, "    aliases: %s\n", strings.Join(group.Aliases, ", "))
			}
			fmt.Fprintf(w, "    https://osv.dev/vulnerability/%s\n", group.Primary)
			if group.ExceptionReason != "" {
				fmt.Fprintf(w, "    reason: %s\n", group.ExceptionReason)
			}
		}
	}

	fmt.Fprintf(w, "\nScanned %d packages: %d clean, %d affected; %d advisory groups (%d blocking, %d excepted).\n",
		len(subjects), clean, affected, groupCount, violationGroupCount, exemptGroupCount)
	var unused []string
	for _, item := range rustExceptions {
		if _, used := usedExceptions[item.ID]; !used {
			unused = append(unused, item.ID)
		}
	}
	if hasRust && len(unused) > 0 {
		fmt.Fprintf(w, "Unused Rust exceptions (candidates for removal): %s\n", strings.Join(unused, ", "))
	}
	return violationGroupCount > 0
}
