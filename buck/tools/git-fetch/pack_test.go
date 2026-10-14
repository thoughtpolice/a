// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/binary"
	"hash/crc32"
	"slices"
	"strings"
	"testing"
)

func TestReadPackResolvesDeltas(t *testing.T) {
	for _, format := range []*objectFormat{sha1Format, sha256Format} {
		t.Run(format.name, func(t *testing.T) {
			b := newPackBuilder(format)
			big := bytes.Repeat([]byte("0123456789abcdef"), 1<<13) // 128 KiB: copies of 64 KiB
			base := b.add(typeBlob, big)
			want := map[oid][]byte{base: big}
			// A chain of offset deltas, each against the last.
			prev := base
			for i := range 4 {
				data := slices.Concat([]byte{byte('a' + i)}, want[prev], []byte("tail"))
				prev = b.addOfsDelta(prev, data)
				want[prev] = data
			}
			// A ref delta against a delta, and one against a later object.
			refData := slices.Concat(want[prev], []byte("by id"))
			ref := b.addRefDelta(prev, refData)
			want[ref] = refData
			empty := b.add(typeBlob, nil)
			want[empty] = []byte{}

			p, err := readPack(format, bytes.NewReader(b.bytes()))
			if err != nil {
				t.Fatal(err)
			}
			if len(p.entries) != len(want) {
				t.Fatalf("read %d entries, want %d", len(p.entries), len(want))
			}
			for id, data := range want {
				typ, got, err := p.object(id)
				if err != nil {
					t.Fatal(err)
				}
				if typ != typeBlob || !bytes.Equal(got, data) {
					t.Errorf("%s: got a %s of %d bytes, want a blob of %d", format.hex(id), typ, len(got), len(data))
				}
			}
		})
	}
}

func TestReadPackFindsRefDeltaBasesLaterInThePack(t *testing.T) {
	b := newPackBuilder(sha1Format)
	baseData := []byte(strings.Repeat("base ", 100))
	baseID := sha1Format.hashObject(typeBlob, baseData)
	b.objects[baseID] = storedObject{typeBlob, baseData}
	deltaID := b.addRefDelta(baseID, append([]byte("x"), baseData...))
	b.add(typeBlob, baseData)
	p, err := readPack(sha1Format, bytes.NewReader(b.bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if _, data, err := p.object(deltaID); err != nil || string(data) != "x"+string(baseData) {
		t.Fatalf("got %q, %v", data, err)
	}
}

func TestReadPackRejectsBadPacks(t *testing.T) {
	good := func() *packBuilder {
		b := newPackBuilder(sha1Format)
		b.add(typeBlob, []byte("hello"))
		return b
	}
	// rehash fixes up the trailing checksum after a test breaks the body.
	rehash := func(data []byte) []byte {
		body := data[:len(data)-sha1Format.size]
		h := sha1Format.newHash()
		h.Write(body)
		return h.Sum(slices.Clone(body))
	}
	missingBase := func() []byte {
		b := newPackBuilder(sha1Format)
		data := []byte("base")
		id := sha1Format.hashObject(typeBlob, data)
		b.objects[id] = storedObject{typeBlob, data}
		b.addRefDelta(id, []byte("based"))
		return b.bytes()
	}
	tests := []struct {
		name, want string
		pack       []byte
	}{
		{"empty", "not a pack", nil},
		{"bad magic", "not a pack", rehash(slices.Concat([]byte("KCAP"), good().bytes()[4:]))},
		{"bad version", "unsupported pack version 4", rehash(slices.Concat(good().bytes()[:7], []byte{4}, good().bytes()[8:]))},
		{"bad checksum", "checksum mismatch", slices.Concat(good().bytes()[:len(good().bytes())-1], []byte{0})},
		{"count too high", "object at offset", rehash(slices.Concat(good().bytes()[:8], []byte{0xff, 0xff, 0xff, 0xff}, good().bytes()[12:]))},
		{"count one too high", "object at offset", rehash(slices.Concat(good().bytes()[:11], []byte{2}, good().bytes()[12:]))},
		{"stray bytes", "stray bytes", func() []byte {
			b := good()
			b.body.WriteString("junk")
			return b.bytes()
		}()},
		{"size too small", "longer than its header says", func() []byte {
			b := newPackBuilder(sha1Format)
			b.header(typeBlob, 4)
			b.deflate([]byte("hello"))
			b.count++
			return b.bytes()
		}()},
		{"size too big", "shorter than its header says", func() []byte {
			b := newPackBuilder(sha1Format)
			b.header(typeBlob, 6)
			b.deflate([]byte("hello"))
			b.count++
			return b.bytes()
		}()},
		{"unknown type", "unknown object type 5", func() []byte {
			b := newPackBuilder(sha1Format)
			b.header(5, 5)
			b.deflate([]byte("hello"))
			b.count++
			return b.bytes()
		}()},
		{"missing delta base", "delta base is not in the pack", missingBase()},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := readPack(sha1Format, bytes.NewReader(tt.pack))
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("got %v, want an error containing %q", err, tt.want)
			}
		})
	}
}

// TestIndex parses the .idx file back, checking it the way git's
// check_packed_git_idx and find_pack_entry do.
func TestIndex(t *testing.T) {
	b := newPackBuilder(sha1Format)
	for i := range 300 {
		b.add(typeBlob, []byte(strings.Repeat("x", i)))
	}
	data := b.bytes()
	p, err := readPack(sha1Format, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	idx := p.index()
	n := len(p.entries)
	size := 8 + 256*4 + n*(20+4+4) + 20 + 20
	if len(idx) != size {
		t.Fatalf("index is %d bytes, want %d", len(idx), size)
	}
	if !bytes.Equal(idx[:8], []byte{0xff, 't', 'O', 'c', 0, 0, 0, 2}) {
		t.Fatalf("bad header %x", idx[:8])
	}
	if total := binary.BigEndian.Uint32(idx[8+255*4:]); int(total) != n {
		t.Fatalf("fan-out total is %d, want %d", total, n)
	}
	ids := idx[8+256*4:]
	crcs := ids[n*20:]
	offsets := crcs[n*4:]
	for i := range n {
		id := sha1Format.idFrom(ids[i*20:])
		if i > 0 && bytes.Compare(ids[(i-1)*20:i*20], ids[i*20:(i+1)*20]) >= 0 {
			t.Fatal("ids are not sorted")
		}
		if first := id[0]; i >= int(binary.BigEndian.Uint32(idx[8+int(first)*4:])) ||
			(first > 0 && i < int(binary.BigEndian.Uint32(idx[8+int(first-1)*4:]))) {
			t.Fatalf("fan-out does not bracket entry %d", i)
		}
		offset := int(binary.BigEndian.Uint32(offsets[i*4:]))
		e := p.entries[p.byID[id]]
		if offset != e.offset {
			t.Fatalf("offset %d, want %d", offset, e.offset)
		}
		if crc := binary.BigEndian.Uint32(crcs[i*4:]); crc != crc32.ChecksumIEEE(data[e.offset:e.end]) {
			t.Fatalf("bad CRC for entry %d", i)
		}
	}
	trailer := offsets[n*4:]
	if !bytes.Equal(trailer[:20], data[len(data)-20:]) {
		t.Fatal("index does not end with the pack's checksum")
	}
	h := sha1Format.newHash()
	h.Write(idx[:len(idx)-20])
	if !bytes.Equal(h.Sum(nil), idx[len(idx)-20:]) {
		t.Fatal("bad index checksum")
	}
}

func TestIndexLargeOffsets(t *testing.T) {
	p := &pack{format: sha1Format, entries: []packEntry{
		{offset: 12, id: oid{1}},
		{offset: 1 << 31, id: oid{2}},
		{offset: 5 << 32, id: oid{3}},
	}}
	idx := p.index()
	offsets := idx[8+256*4+3*(20+4):]
	want := []uint32{12, 1<<31 | 0, 1<<31 | 1}
	for i, w := range want {
		if got := binary.BigEndian.Uint32(offsets[i*4:]); got != w {
			t.Errorf("offset %d is %#x, want %#x", i, got, w)
		}
	}
	large := offsets[3*4:]
	if a, b := binary.BigEndian.Uint64(large), binary.BigEndian.Uint64(large[8:]); a != 1<<31 || b != 5<<32 {
		t.Errorf("large offsets %#x %#x", a, b)
	}
}

func TestObjectCacheEvictsLeastRecentlyUsed(t *testing.T) {
	c := newObjectCache(40)
	c.put(1, make([]byte, 10))
	c.put(2, make([]byte, 10))
	c.put(3, make([]byte, 10))
	c.get(1)
	c.put(4, make([]byte, 10)) // fits
	c.put(5, make([]byte, 10)) // evicts 2, the least recently used
	c.put(6, make([]byte, 11)) // too big to cache at all
	for i, want := range map[int]bool{1: true, 2: false, 3: true, 4: true, 5: true, 6: false} {
		if _, ok := c.get(i); ok != want {
			t.Errorf("entry %d cached: %v, want %v", i, ok, want)
		}
	}
	if c.used != 40 {
		t.Errorf("used %d bytes, want 40", c.used)
	}
}
