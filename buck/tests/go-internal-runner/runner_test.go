// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package internalrunner

import (
	"fmt"
	"testing"
)

func TestPass(t *testing.T) {
	t.Log("top-level test ran")
}

func TestSkip(t *testing.T) {
	t.Skip("exercise internal-runner skip reporting")
}

func TestSubtests(t *testing.T) {
	for _, name := range []string{"first", "second"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
		})
	}
}

func FuzzRoundTrip(f *testing.F) {
	f.Add("depot")
	f.Fuzz(func(t *testing.T, input string) {
		if got := string([]byte(input)); got != input {
			t.Fatalf("round trip = %q, want %q", got, input)
		}
	})
}

func Example_internalRunner() {
	fmt.Println("example ran")
	// Output: example ran
}

// The listing parser must exclude benchmarks: ordinary `go test` does not run
// them unless -bench is explicitly requested.
func BenchmarkNotATest(b *testing.B) {
	for b.Loop() {
	}
}
