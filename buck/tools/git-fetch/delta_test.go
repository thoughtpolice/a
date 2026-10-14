// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"strings"
	"testing"
)

func TestApplyDelta(t *testing.T) {
	base := []byte("the quick brown fox")
	tests := []struct {
		name  string
		delta []byte
		want  string
	}{
		{"insert only", []byte{19, 3, 3, 'a', 'b', 'c'}, "abc"},
		// 0x91: offset byte 0, size byte 0; offset 4, size 5.
		{"copy", []byte{19, 5, 0x91, 4, 5}, "quick"},
		{"copy with no offset bytes", []byte{19, 3, 0x90, 3}, "the"},
		{"copy then insert", []byte{19, 9, 0x90, 4, 5, 'q', 'u', 'i', 'c', 'k'}, "the quick"},
		{"empty", []byte{19, 0}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := applyDelta(base, tt.delta)
			if err != nil || string(got) != tt.want {
				t.Fatalf("got %q, %v; want %q", got, err, tt.want)
			}
		})
	}
}

func TestApplyDeltaCopySizeZeroMeans64KiB(t *testing.T) {
	base := bytes.Repeat([]byte{'x'}, 0x10000)
	delta := append(appendDeltaSize(appendDeltaSize(nil, len(base)), len(base)), 0x80)
	got, err := applyDelta(base, delta)
	if err != nil || !bytes.Equal(got, base) {
		t.Fatalf("got %d bytes, %v", len(got), err)
	}
}

func TestApplyDeltaRejectsBadDeltas(t *testing.T) {
	base := []byte("0123456789")
	tests := []struct {
		name  string
		delta []byte
		want  string
	}{
		{"truncated header", []byte{0x80}, "truncated"},
		{"wrong base size", []byte{9, 0}, "expects a 9-byte base"},
		{"reserved instruction", []byte{10, 1, 0}, "reserved"},
		{"copy past the end", []byte{10, 5, 0x91, 8, 5}, "past the end"},
		{"truncated copy", []byte{10, 5, 0x91, 8}, "truncated"},
		{"truncated insert", []byte{10, 5, 5, 'a'}, "truncated"},
		{"too long", []byte{10, 1, 2, 'a', 'b'}, "more than"},
		{"too short", []byte{10, 3, 1, 'a'}, "produces 1 bytes, not the 3"},
		{"size overflows", bytes.Repeat([]byte{0xff}, 10), "overflows"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := applyDelta(base, tt.delta)
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("got %v, want an error containing %q", err, tt.want)
			}
		})
	}
}

func TestMakeDeltaRoundTrips(t *testing.T) {
	base := []byte(strings.Repeat("abc", 50000))
	for _, target := range []string{"", "abc", strings.Repeat("abc", 50000) + "!", "!" + strings.Repeat("abc", 30000), "zzz"} {
		got, err := applyDelta(base, makeDelta(base, []byte(target)))
		if err != nil || string(got) != target {
			t.Fatalf("round trip of a %d-byte target: %v", len(target), err)
		}
	}
}
