// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

// This module owns an agent's renewable, fenced claim while planning, running
// tests, and uploading evidence. A monotonic local watchdog cancels work before
// uncertain ownership can produce a completion; server wall clocks are never
// used as local deadlines. Completion and renewal are serialized so a successful
// completion cannot be mistaken for a failed heartbeat on the completed job.
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// errLeaseLost distinguishes unavailable ownership from an operational job
// failure: the former must never be uploaded as a job_error or acknowledged.
var errLeaseLost = errors.New("job lease lost")

// leaseReceipt is the broker's identity-preserving acknowledgement of renewal.
// LeaseUntil is checked for protocol consistency, not compared with local time.
type leaseReceipt struct {
	JobID      string `json:"job_id"`
	AgentID    string `json:"agent_id"`
	LeaseToken int    `json:"lease_token"`
	LeaseUntil int64  `json:"lease_until"`
}

// jobLease has one heartbeat owner and an independently firing expiry watchdog.
// operation serializes network renewals against the final completion; mu guards
// watchdog state without holding a lock during any network operation.
type jobLease struct {
	ctx       context.Context
	cancel    context.CancelCauseFunc
	heartbeat context.Context
	stopBeat  context.CancelFunc
	done      chan struct{}
	operation sync.Mutex
	mu        sync.Mutex
	deadline  time.Time
	until     int64
	timer     *time.Timer
	duration  time.Duration
	identity  leaseReceipt
}

// startJobLease anchors ownership at the *start* of the claim request. Network
// latency consumes the requested lease; a late response cannot restart it.
func (c *client) startJobLease(parent context.Context, options agentOptions, claimed job, started time.Time) (*jobLease, error) {
	if claimed.ID == "" || claimed.LeaseToken <= 0 || claimed.AgentID == "" || claimed.AgentID != options.AgentID || claimed.LeaseUntil <= 0 {
		return nil, fmt.Errorf("%w: invalid claim identity or deadline", errLeaseLost)
	}
	duration := options.Lease.Truncate(time.Millisecond)
	deadline := started.Add(duration)
	if duration <= 0 || duration > maximumAgentLease || !time.Now().Before(deadline) {
		return nil, fmt.Errorf("%w: claim response arrived after its local deadline", errLeaseLost)
	}
	ctx, cancel := context.WithCancelCause(parent)
	heartbeat, stopBeat := context.WithCancel(ctx)
	l := &jobLease{
		ctx: ctx, cancel: cancel, heartbeat: heartbeat, stopBeat: stopBeat,
		done: make(chan struct{}), deadline: deadline, until: claimed.LeaseUntil,
		duration: duration,
		identity: leaseReceipt{JobID: claimed.ID, AgentID: options.AgentID, LeaseToken: claimed.LeaseToken},
	}
	l.timer = time.AfterFunc(time.Until(deadline), l.expire)
	go l.run(c, options.Queue)
	return l, nil
}

// expire also checks the current deadline: an already queued timer callback may
// run after Reset, and must not cancel a more recently renewed lease.
func (l *jobLease) expire() {
	l.mu.Lock()
	defer l.mu.Unlock()
	if !time.Now().Before(l.deadline) {
		l.cancel(fmt.Errorf("%w: renewal deadline elapsed", errLeaseLost))
	}
}

// err makes an expiry observable even if the timer callback has not run yet.
func (l *jobLease) err() error {
	l.expire()
	return context.Cause(l.ctx)
}

func (l *jobLease) run(c *client, queue string) {
	defer close(l.done)
	delay := l.nextDelay(false)
	for waitForAgentPoll(l.heartbeat, delay) == nil {
		l.operation.Lock()
		if l.heartbeat.Err() != nil {
			l.operation.Unlock()
			return
		}
		retry := l.renew(c, queue)
		l.operation.Unlock()
		delay = l.nextDelay(retry)
	}
}

// nextDelay reserves most of the remaining confirmed budget for another
// request even when a successful acknowledgement consumed substantial latency.
func (l *jobLease) nextDelay(retry bool) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	delay := time.Until(l.deadline) / 3
	if retry {
		return min(delay, l.duration/10, time.Second)
	}
	return min(delay, l.duration/3)
}

// renew retries only transport/server throttling failures. Every request is
// bounded by the last proven deadline, including stalled response bodies.
func (l *jobLease) renew(c *client, queue string) bool {
	l.mu.Lock()
	deadline, until := l.deadline, l.until
	l.mu.Unlock()
	if l.err() != nil {
		return false
	}
	ctx, cancel := context.WithDeadline(l.heartbeat, deadline)
	defer cancel()
	started := time.Now()
	var receipt leaseReceipt
	status, err := c.requestContext(ctx, http.MethodPost, "/v1/queues/"+url.PathEscape(queue)+"/renew", map[string]any{
		"job_id": l.identity.JobID, "agent_id": l.identity.AgentID,
		"lease_token": l.identity.LeaseToken, "lease_ms": l.duration.Milliseconds(),
	}, &receipt)
	if l.heartbeat.Err() != nil {
		return false // Completion or shutdown canceled this request deliberately.
	}
	if l.err() != nil {
		return false
	}
	if err != nil {
		if status == 0 || status == http.StatusTooManyRequests || status >= 500 {
			return true
		}
		l.cancel(fmt.Errorf("%w: renewal rejected: %v", errLeaseLost, err))
		return false
	}
	if status != http.StatusOK || receipt.JobID != l.identity.JobID || receipt.AgentID != l.identity.AgentID ||
		receipt.LeaseToken != l.identity.LeaseToken || receipt.LeaseUntil <= 0 || receipt.LeaseUntil < until {
		l.cancel(fmt.Errorf("%w: invalid renewal identity or deadline", errLeaseLost))
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if !time.Now().Before(l.deadline) || l.ctx.Err() != nil {
		l.cancel(fmt.Errorf("%w: late renewal response", errLeaseLost))
		return false
	}
	l.until = receipt.LeaseUntil
	l.deadline = maxTime(l.deadline, started.Add(l.duration))
	l.timer.Reset(time.Until(l.deadline))
	return false
}

func maxTime(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

// complete obtains a fresh lease and permanently stops renewal before sending
// the final fenced request. Completion then uses that acknowledged budget.
func (l *jobLease) complete(c *client, queue string, send func(context.Context) error) error {
	l.operation.Lock()
	defer l.operation.Unlock()
	for l.renew(c, queue) {
		if err := waitForAgentPoll(l.ctx, l.nextDelay(true)); err != nil {
			return context.Cause(l.ctx)
		}
	}
	l.stopBeat()
	if err := l.err(); err != nil {
		return err
	}
	l.mu.Lock()
	deadline := l.deadline
	l.mu.Unlock()
	ctx, cancel := context.WithDeadline(l.ctx, deadline)
	defer cancel()
	err := send(ctx)
	if ownershipErr := l.err(); ownershipErr != nil {
		return ownershipErr
	}
	if err == nil {
		l.timer.Stop()
	}
	return err
}

// close joins the heartbeat and releases timers on every success/error path.
func (l *jobLease) close() {
	l.stopBeat()
	<-l.done
	l.timer.Stop()
	l.cancel(context.Canceled)
}
