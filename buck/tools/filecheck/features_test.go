// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import "testing"

func TestEvalBoolExpr(t *testing.T) {
	features := map[string]bool{"a": true, "b": true, "x86_64": true, "system-linux": true}
	cases := []struct {
		expr string
		want bool
	}{
		{"true", true},
		{"!true", false},
		{"true && c", false},
		{"true || c", true},
		{"{{tr.*}}", true},
		{"a", true},
		{"c", false},
		{"!c", true},
		{"a && b", true},
		{"a && c", false},
		{"a || c", true},
		{"c || d", false},
		{"!(a && c)", true},
		{"(a || c) && b", true},
		{"a && !b", false},
		{"{{x86.*}}", true},
		{"{{arm.*}}", false},
		{"system-linux && x86_64", true},
	}
	for _, c := range cases {
		got, err := evalBoolExpr(c.expr, features)
		if err != nil {
			t.Errorf("evalBoolExpr(%q): %v", c.expr, err)
			continue
		}
		if got != c.want {
			t.Errorf("evalBoolExpr(%q) = %v, want %v", c.expr, got, c.want)
		}
	}
	for _, bad := range []string{"", "a &&", "(a", "a b", "&& a", "{{unterminated"} {
		if _, err := evalBoolExpr(bad, features); err == nil {
			t.Errorf("evalBoolExpr(%q) accepted", bad)
		}
	}
}

func TestIntrinsicTrueDoesNotModifyFeatures(t *testing.T) {
	features := map[string]bool{"true": false}
	for _, expr := range []string{"true", "{{true}}"} {
		if got, err := evalBoolExpr(expr, features); err != nil || !got {
			t.Errorf("evalBoolExpr(%q) = %v, %v", expr, got, err)
		}
	}
	if features["true"] {
		t.Error("evaluation modified the caller's feature set")
	}
}

func TestHostFeatures(t *testing.T) {
	feats := map[string]bool{}
	for _, f := range hostFeatures() {
		feats[f] = true
	}
	if !feats["filecheck"] {
		t.Errorf("missing filecheck feature: %v", feats)
	}
	hasSystem := false
	for f := range feats {
		if len(f) > 7 && f[:7] == "system-" {
			hasSystem = true
		}
	}
	if !hasSystem {
		t.Errorf("missing system-* feature: %v", feats)
	}
}
