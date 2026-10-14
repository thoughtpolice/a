// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// Package x checks that a Go target imports golang.org/x packages with
// no dependency of its own: one or two from every pinned module, including
// ones with assembly (chacha20poly1305, cpu) and go:embed (publicsuffix).
package x

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/chacha20poly1305"
	"golang.org/x/net/html"
	"golang.org/x/net/publicsuffix"
	"golang.org/x/oauth2"
	"golang.org/x/sys/cpu"
	"golang.org/x/term"
	"golang.org/x/text/cases"
	"golang.org/x/text/language"
	"golang.org/x/time/rate"
)

func TestCrypto(t *testing.T) {
	aead, err := chacha20poly1305.New(make([]byte, chacha20poly1305.KeySize))
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, aead.NonceSize())
	sealed := aead.Seal(nil, nonce, []byte("hello"), nil)
	opened, err := aead.Open(nil, nonce, sealed, nil)
	if err != nil || !bytes.Equal(opened, []byte("hello")) {
		t.Fatalf("round trip: %q, %v", opened, err)
	}
}

func TestNet(t *testing.T) {
	doc, err := html.Parse(strings.NewReader("<p>hi</p>"))
	if err != nil {
		t.Fatal(err)
	}
	if doc.FirstChild == nil {
		t.Fatal("empty document")
	}

	// The suffix list is embedded with go:embed.
	etld1, err := publicsuffix.EffectiveTLDPlusOne("www.example.co.uk")
	if err != nil || etld1 != "example.co.uk" {
		t.Fatalf("EffectiveTLDPlusOne = %q, %v", etld1, err)
	}
}

func TestOAuth2(t *testing.T) {
	conf := &oauth2.Config{
		ClientID: "id",
		Endpoint: oauth2.Endpoint{AuthURL: "https://example.com/auth"},
	}
	if url := conf.AuthCodeURL("state"); !strings.Contains(url, "client_id=id") {
		t.Fatalf("AuthCodeURL = %q", url)
	}
}

func TestSys(t *testing.T) {
	_ = cpu.CacheLinePad{}
	t.Logf("x86 AVX2: %v, arm64 ASIMD: %v", cpu.X86.HasAVX2, cpu.ARM64.HasASIMD)
}

func TestTerm(t *testing.T) {
	// Buck2 captures a test's output, so this is never a terminal.
	t.Logf("stdin is a terminal: %v", term.IsTerminal(0))
}

func TestText(t *testing.T) {
	if got := cases.Title(language.English).String("hello world"); got != "Hello World" {
		t.Fatalf("Title = %q", got)
	}
}

func TestTime(t *testing.T) {
	limiter := rate.NewLimiter(rate.Every(time.Hour), 1)
	if !limiter.Allow() || limiter.Allow() {
		t.Fatal("expected exactly one token")
	}
}
