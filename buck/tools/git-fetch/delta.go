// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"errors"
	"fmt"
)

// maxPrealloc caps what is allocated up front on the word of a size that
// the server sent; anything larger grows as it is actually produced.
const maxPrealloc = 64 << 20

var errDeltaTruncated = errors.New("delta is truncated")

// applyDelta rebuilds an object from its base and a git delta: two sizes,
// then instructions that either copy a range of the base or insert bytes
// carried in the delta.
func applyDelta(base, delta []byte) ([]byte, error) {
	baseSize, delta, err := deltaSize(delta)
	if err != nil {
		return nil, err
	}
	resultSize, delta, err := deltaSize(delta)
	if err != nil {
		return nil, err
	}
	if baseSize != uint64(len(base)) {
		return nil, fmt.Errorf("delta expects a %d-byte base, not %d bytes", baseSize, len(base))
	}
	out := make([]byte, 0, min(resultSize, maxPrealloc))
	for len(delta) > 0 {
		op := delta[0]
		delta = delta[1:]
		switch {
		case op&0x80 != 0:
			// Copy: bits 0-3 say which offset bytes follow, bits 4-6
			// which size bytes, both little-endian.
			var offset, size uint64
			for i := range 4 {
				if op&(1<<i) != 0 {
					if len(delta) == 0 {
						return nil, errDeltaTruncated
					}
					offset |= uint64(delta[0]) << (8 * i)
					delta = delta[1:]
				}
			}
			for i := range 3 {
				if op&(0x10<<i) != 0 {
					if len(delta) == 0 {
						return nil, errDeltaTruncated
					}
					size |= uint64(delta[0]) << (8 * i)
					delta = delta[1:]
				}
			}
			if size == 0 {
				size = 0x10000
			}
			if offset+size > uint64(len(base)) {
				return nil, errors.New("delta copies past the end of its base")
			}
			out = append(out, base[offset:offset+size]...)
		case op != 0:
			n := int(op)
			if n > len(delta) {
				return nil, errDeltaTruncated
			}
			out = append(out, delta[:n]...)
			delta = delta[n:]
		default:
			return nil, errors.New("delta uses the reserved instruction 0")
		}
		if uint64(len(out)) > resultSize {
			return nil, fmt.Errorf("delta produces more than the %d bytes it promises", resultSize)
		}
	}
	if uint64(len(out)) != resultSize {
		return nil, fmt.Errorf("delta produces %d bytes, not the %d it promises", len(out), resultSize)
	}
	return out, nil
}

// deltaSize decodes one of a delta's leading sizes, which are base-128
// little-endian.
func deltaSize(b []byte) (uint64, []byte, error) {
	var v uint64
	for i, c := range b {
		if i == 9 {
			return 0, nil, errors.New("delta size overflows")
		}
		v |= uint64(c&0x7f) << (7 * i)
		if c&0x80 == 0 {
			return v, b[i+1:], nil
		}
	}
	return 0, nil, errDeltaTruncated
}
