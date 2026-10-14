// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"fmt"
	"io"
	"strconv"
)

// Packet kinds in git's pkt-line framing: a four-hex-digit length that
// counts itself, then the payload. Lengths 0 to 2 are special packets.
const (
	pktData = iota
	pktFlush
	pktDelim
	pktResponseEnd
)

const maxPktLen = 65520

type pktReader struct {
	r   io.Reader
	buf [maxPktLen]byte
}

// next returns the next packet. A data packet's payload is only valid
// until the next call. Read errors are retryable, since a connection that
// drops mid-response is worth another attempt; malformed packets are not.
// A packet that starts with "ERR " is the server reporting an error.
func (p *pktReader) next() (int, []byte, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(p.r, hdr[:]); err != nil {
		return 0, nil, readError(err)
	}
	n, err := strconv.ParseUint(string(hdr[:]), 16, 16)
	if err != nil {
		return 0, nil, fmt.Errorf("malformed pkt-line length %q", hdr[:])
	}
	switch {
	case n == 0:
		return pktFlush, nil, nil
	case n == 1:
		return pktDelim, nil, nil
	case n == 2:
		return pktResponseEnd, nil, nil
	case n < 4 || n > maxPktLen:
		return 0, nil, fmt.Errorf("malformed pkt-line length %q", hdr[:])
	}
	data := p.buf[:n-4]
	if _, err := io.ReadFull(p.r, data); err != nil {
		return 0, nil, readError(err)
	}
	if msg, ok := bytes.CutPrefix(data, []byte("ERR ")); ok {
		return 0, nil, fmt.Errorf("the server said: %s", bytes.TrimSuffix(msg, []byte("\n")))
	}
	return pktData, data, nil
}

// line reads a data packet and returns it without its trailing newline.
func (p *pktReader) line() (int, string, error) {
	kind, data, err := p.next()
	return kind, string(bytes.TrimSuffix(data, []byte("\n"))), err
}

func readError(err error) error {
	if err == io.EOF {
		err = io.ErrUnexpectedEOF
	}
	return retryable(fmt.Errorf("reading the server's response: %w", err))
}

func writePktLine(b *bytes.Buffer, s string) {
	fmt.Fprintf(b, "%04x%s", len(s)+4, s)
}
