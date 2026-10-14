// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"compress/zlib"
	"container/list"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"runtime"
	"slices"
	"sync"
	"sync/atomic"
)

const packHeaderSize = 12

// pack is a packfile held in memory. Reading it computes every object's
// id from its contents, so an object found by id is the object that id
// names, and a commit found by id vouches for its whole tree. Once read,
// it is safe for concurrent use.
type pack struct {
	format   *objectFormat
	data     []byte
	checksum oid
	entries  []packEntry // in pack order, so sorted by offset
	byID     map[oid]int
	cache    *objectCache
}

type packEntry struct {
	offset     int        // where the entry's header starts
	dataOffset int        // where its zlib stream starts
	end        int        // where the next entry starts
	stored     objectType // an object type, or one of the two deltas
	storedSize int        // inflated size of what is stored
	baseOffset int        // ofs-delta: where the base entry starts
	baseID     oid        // ref-delta: the base object's id
	base       int        // deltas: the base entry's index, once known
	isBase     bool       // some delta is against this entry
	typ        objectType // the object's type, after resolving deltas
	id         oid
	crc        uint32 // of the entry's bytes, for the .idx file
	resolved   bool
}

func (e *packEntry) isDelta() bool {
	return e.stored == typeOfsDelta || e.stored == typeRefDelta
}

// readPack reads a pack from r to its end, and checks it: its trailing
// checksum, every entry's inflated size, and every delta. Whole objects
// are hashed as the pack arrives, and deltas resolved once all of it has.
func readPack(format *objectFormat, r io.Reader) (*pack, error) {
	s := &packStream{src: r}
	var header [packHeaderSize]byte
	if _, err := io.ReadFull(s, header[:]); err != nil {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return nil, errors.New("not a pack: it is too short")
		}
		return nil, err
	}
	if string(header[:4]) != "PACK" {
		return nil, errors.New("not a pack")
	}
	if v := binary.BigEndian.Uint32(header[4:]); v != 2 && v != 3 {
		return nil, fmt.Errorf("unsupported pack version %d", v)
	}
	count := binary.BigEndian.Uint32(header[8:])
	p := &pack{
		format:  format,
		entries: make([]packEntry, 0, min(count, 1<<16)),
		cache:   newObjectCache(cacheBudget),
	}
	var inf inflater
	for range count {
		offset := s.pos
		e, err := p.readEntry(s, &inf)
		if err != nil {
			return nil, fmt.Errorf("object at offset %d: %w", offset, err)
		}
		p.entries = append(p.entries, e)
	}
	body := s.pos
	trailer := make([]byte, format.size)
	if _, err := io.ReadFull(s, trailer); err != nil {
		return nil, fmt.Errorf("reading the pack's checksum: %w", err)
	}
	if n, err := io.Copy(io.Discard, s); err != nil {
		return nil, err
	} else if n > 0 {
		return nil, fmt.Errorf("pack has %d stray bytes after its checksum", n)
	}
	p.data = s.buf[:s.pos]
	h := format.newHash()
	h.Write(p.data[:body])
	if !bytes.Equal(h.Sum(nil), trailer) {
		return nil, errors.New("pack checksum mismatch")
	}
	p.checksum = format.idFrom(trailer)
	if err := p.resolveDeltas(); err != nil {
		return nil, err
	}
	// git's index-pack accepts an object stored twice, unless --strict;
	// either copy will do.
	p.byID = make(map[oid]int, len(p.entries))
	for i := range p.entries {
		if _, dup := p.byID[p.entries[i].id]; !dup {
			p.byID[p.entries[i].id] = i
		}
	}
	return p, nil
}

// packStream reads a pack, keeping every byte it has read, so that the
// parser knows exactly where each entry starts and ends.
type packStream struct {
	src io.Reader
	buf []byte // all of the pack read so far
	pos int    // how much of buf the parser has consumed
}

func (s *packStream) fill() error {
	if len(s.buf) == cap(s.buf) {
		s.buf = slices.Grow(s.buf, max(len(s.buf), 64<<10))
	}
	n, err := s.src.Read(s.buf[len(s.buf):cap(s.buf)])
	s.buf = s.buf[:len(s.buf)+n]
	if n > 0 {
		return nil
	}
	if err == nil {
		err = io.ErrNoProgress
	}
	return err
}

func (s *packStream) Read(b []byte) (int, error) {
	for s.pos == len(s.buf) {
		if err := s.fill(); err != nil {
			return 0, err
		}
	}
	n := copy(b, s.buf[s.pos:])
	s.pos += n
	return n, nil
}

func (s *packStream) ReadByte() (byte, error) {
	for s.pos == len(s.buf) {
		if err := s.fill(); err != nil {
			if err == io.EOF {
				err = io.ErrUnexpectedEOF
			}
			return 0, err
		}
	}
	s.pos++
	return s.buf[s.pos-1], nil
}

// readEntry parses the entry at the stream's position. Whole objects are
// hashed as they are inflated; deltas are only inflated, to find where
// they end.
func (p *pack) readEntry(s *packStream, inf *inflater) (packEntry, error) {
	e := packEntry{offset: s.pos, base: -1}
	c, err := s.ReadByte()
	if err != nil {
		return e, err
	}
	e.stored = objectType(c >> 4 & 7)
	size := uint64(c & 15)
	for shift := 4; c&0x80 != 0; shift += 7 {
		if shift > 56 {
			return e, errors.New("object size overflows")
		}
		if c, err = s.ReadByte(); err != nil {
			return e, err
		}
		size |= uint64(c&0x7f) << shift
	}
	e.storedSize = int(size)

	switch e.stored {
	case typeCommit, typeTree, typeBlob, typeTag:
	case typeOfsDelta:
		// The base's distance back, big-endian base-128, where each
		// continuation also adds one so that no value has two encodings.
		if c, err = s.ReadByte(); err != nil {
			return e, err
		}
		rel := uint64(c & 0x7f)
		for c&0x80 != 0 {
			if rel >= 1<<56 {
				return e, errors.New("delta base offset overflows")
			}
			if c, err = s.ReadByte(); err != nil {
				return e, err
			}
			rel = (rel+1)<<7 | uint64(c&0x7f)
		}
		if rel == 0 || rel > uint64(e.offset-packHeaderSize) {
			return e, errors.New("delta base offset is out of range")
		}
		e.baseOffset = e.offset - int(rel)
	case typeRefDelta:
		id := make([]byte, p.format.size)
		if _, err := io.ReadFull(s, id); err != nil {
			return e, noEOF(err)
		}
		e.baseID = p.format.idFrom(id)
	default:
		return e, fmt.Errorf("unknown object type %d", e.stored)
	}
	e.dataOffset = s.pos

	var sink io.Writer = io.Discard
	h := p.format.newHash()
	if !e.isDelta() {
		writeObjectHeader(h, e.stored, e.storedSize)
		sink = h
	}
	if err := inf.inflate(s, sink, e.storedSize); err != nil {
		return e, err
	}
	e.end = s.pos
	if !e.isDelta() {
		e.typ = e.stored
		e.id = p.format.sum(h)
		e.resolved = true
	}
	e.crc = crc32.ChecksumIEEE(s.buf[e.offset:e.end])
	return e, nil
}

func noEOF(err error) error {
	if err == io.EOF {
		return io.ErrUnexpectedEOF
	}
	return err
}

// inflater is a reusable zlib decompressor.
type inflater struct {
	z io.ReadCloser
}

var inflaters = sync.Pool{New: func() any { return new(inflater) }}

// inflate decompresses the zlib stream at r, which must hold exactly size
// bytes, into w. Since r is an io.ByteReader, neither zlib nor flate reads
// past the end of the stream, so r is left just after it.
func (inf *inflater) inflate(r interface {
	io.Reader
	io.ByteReader
}, w io.Writer, size int) error {
	var err error
	if inf.z == nil {
		inf.z, err = zlib.NewReader(r)
	} else {
		err = inf.z.(zlib.Resetter).Reset(r, nil)
	}
	if err != nil {
		return noEOF(err)
	}
	if _, err := io.CopyN(w, inf.z, int64(size)); err != nil {
		if err == io.EOF {
			return errors.New("object is shorter than its header says")
		}
		return err
	}
	// Reading on reaches the end of the stream and checks its adler32.
	var one [1]byte
	n, err := inf.z.Read(one[:])
	if n != 0 {
		return errors.New("object is longer than its header says")
	}
	if err != io.EOF {
		if err == nil {
			err = io.ErrNoProgress
		}
		return err
	}
	return nil
}

// inflate returns what entry i stores: an object, or a delta.
func (p *pack) inflate(i int) ([]byte, error) {
	e := &p.entries[i]
	var buf bytes.Buffer
	buf.Grow(min(e.storedSize, maxPrealloc))
	inf := inflaters.Get().(*inflater)
	defer inflaters.Put(inf)
	if err := inf.inflate(bytes.NewReader(p.data[e.dataOffset:e.end]), &buf, e.storedSize); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// resolveDeltas applies every delta, starting from each whole object and
// working outwards through the deltas against it, so that each base is
// inflated once for all of its deltas, as git's index-pack does. Whole
// objects are independent of each other, so they are worked on in
// parallel.
func (p *pack) resolveDeltas() error {
	byBaseOffset := map[int][]int{}
	byBaseID := map[oid][]int{}
	for i := range p.entries {
		e := &p.entries[i]
		switch e.stored {
		case typeOfsDelta:
			byBaseOffset[e.baseOffset] = append(byBaseOffset[e.baseOffset], i)
		case typeRefDelta:
			byBaseID[e.baseID] = append(byBaseID[e.baseID], i)
		}
	}
	if len(byBaseOffset) == 0 && len(byBaseID) == 0 {
		return nil
	}

	// A delta could be reached from two bases if the pack held its base
	// twice; whoever claims it first resolves it.
	claimed := make([]atomic.Bool, len(p.entries))
	var resolve func(i int, data []byte) error
	resolve = func(i int, data []byte) error {
		e := &p.entries[i]
		for _, j := range slices.Concat(byBaseOffset[e.offset], byBaseID[e.id]) {
			if !claimed[j].CompareAndSwap(false, true) {
				continue
			}
			d := &p.entries[j]
			delta, err := p.inflate(j)
			if err != nil {
				return fmt.Errorf("object at offset %d: %w", d.offset, err)
			}
			out, err := applyDelta(data, delta)
			if err != nil {
				return fmt.Errorf("object at offset %d: %w", d.offset, err)
			}
			e.isBase = true
			d.base = i
			d.typ = e.typ
			d.id = p.format.hashObject(d.typ, out)
			d.resolved = true
			if err := resolve(j, out); err != nil {
				return err
			}
		}
		return nil
	}
	var roots []int
	for i := range p.entries {
		e := &p.entries[i]
		if !e.isDelta() && (byBaseOffset[e.offset] != nil || byBaseID[e.id] != nil) {
			roots = append(roots, i)
		}
	}
	err := forEach(runtime.GOMAXPROCS(0), len(roots), func(n int) error {
		i := roots[n]
		data, err := p.inflate(i)
		if err != nil {
			return fmt.Errorf("object at offset %d: %w", p.entries[i].offset, err)
		}
		return resolve(i, data)
	})
	if err != nil {
		return err
	}
	for i := range p.entries {
		if e := &p.entries[i]; !e.resolved {
			return fmt.Errorf("object at offset %d: its delta base is not in the pack", e.offset)
		}
	}
	return nil
}

// forEach calls f for 0 to n-1 on up to workers goroutines, stopping at,
// and returning, the first error.
func forEach(workers, n int, f func(int) error) error {
	var (
		next     atomic.Int64
		failed   atomic.Bool
		firstErr error
		once     sync.Once
		wg       sync.WaitGroup
	)
	for range min(workers, n) {
		wg.Go(func() {
			for !failed.Load() {
				i := int(next.Add(1) - 1)
				if i >= n {
					return
				}
				if err := f(i); err != nil {
					once.Do(func() { firstErr = err })
					failed.Store(true)
				}
			}
		})
	}
	wg.Wait()
	return firstErr
}

// object returns an object's type and contents. The contents may be
// shared with the cache and must not be modified.
func (p *pack) object(id oid) (objectType, []byte, error) {
	i, ok := p.byID[id]
	if !ok {
		return 0, nil, fmt.Errorf("the pack does not contain %s", p.format.hex(id))
	}
	data, err := p.entryData(i)
	if err != nil {
		return 0, nil, fmt.Errorf("object at offset %d: %w", p.entries[i].offset, err)
	}
	return p.entries[i].typ, data, nil
}

func (p *pack) entryData(i int) ([]byte, error) {
	if data, ok := p.cache.get(i); ok {
		return data, nil
	}
	e := &p.entries[i]
	if !e.isDelta() {
		data, err := p.inflate(i)
		if err == nil && e.isBase {
			p.cache.put(i, data)
		}
		return data, err
	}
	base, err := p.entryData(e.base)
	if err != nil {
		return nil, err
	}
	delta, err := p.inflate(i)
	if err != nil {
		return nil, err
	}
	data, err := applyDelta(base, delta)
	if err == nil && e.isBase {
		p.cache.put(i, data)
	}
	return data, err
}

// index renders the pack's version 2 .idx file: a fan-out table over the
// ids' first bytes, then the sorted ids, each entry's CRC32 and offset,
// a table for offsets beyond 2 GiB, and the two checksums.
func (p *pack) index() []byte {
	f := p.format
	order := make([]int, len(p.entries))
	for i := range order {
		order[i] = i
	}
	slices.SortFunc(order, func(a, b int) int {
		return bytes.Compare(p.entries[a].id[:f.size], p.entries[b].id[:f.size])
	})

	var out bytes.Buffer
	out.Write([]byte{0xff, 't', 'O', 'c', 0, 0, 0, 2})
	var fanout [256]uint32
	for _, i := range order {
		fanout[p.entries[i].id[0]]++
	}
	var total uint32
	for _, n := range fanout {
		total += n
		out.Write(binary.BigEndian.AppendUint32(nil, total))
	}
	for _, i := range order {
		out.Write(p.entries[i].id[:f.size])
	}
	for _, i := range order {
		out.Write(binary.BigEndian.AppendUint32(nil, p.entries[i].crc))
	}
	var large []uint64
	for _, i := range order {
		offset := uint64(p.entries[i].offset)
		if offset < 1<<31 {
			out.Write(binary.BigEndian.AppendUint32(nil, uint32(offset)))
		} else {
			out.Write(binary.BigEndian.AppendUint32(nil, 1<<31|uint32(len(large))))
			large = append(large, offset)
		}
	}
	for _, offset := range large {
		out.Write(binary.BigEndian.AppendUint64(nil, offset))
	}
	out.Write(p.checksum[:f.size])
	h := f.newHash()
	h.Write(out.Bytes())
	out.Write(h.Sum(nil))
	return out.Bytes()
}

// cacheBudget bounds the delta bases kept inflated while checking out.
const cacheBudget = 96 << 20

// objectCache is a least-recently-used cache of inflated objects, by
// entry index, bounded by their total size.
type objectCache struct {
	mu           sync.Mutex
	budget, used int
	order        *list.List // of int entry indexes, most recent first
	items        map[int]cacheItem
}

type cacheItem struct {
	data []byte
	elem *list.Element
}

func newObjectCache(budget int) *objectCache {
	return &objectCache{budget: budget, order: list.New(), items: map[int]cacheItem{}}
}

func (c *objectCache) get(i int) ([]byte, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	item, ok := c.items[i]
	if ok {
		c.order.MoveToFront(item.elem)
	}
	return item.data, ok
}

func (c *objectCache) put(i int, data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.items[i]; ok || len(data) > c.budget/4 {
		return
	}
	for c.used+len(data) > c.budget {
		oldest := c.order.Back()
		j := c.order.Remove(oldest).(int)
		c.used -= len(c.items[j].data)
		delete(c.items, j)
	}
	c.items[i] = cacheItem{data, c.order.PushFront(i)}
	c.used += len(data)
}
