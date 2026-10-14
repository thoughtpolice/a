// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxResponseBytes = 64 << 20
	maxQueryPages    = 100
	requestAttempts  = 3
)

type osvClient struct {
	baseURL string
	http    *http.Client
}

func newOSVClient(baseURL string, timeout time.Duration) (*osvClient, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("invalid OSV API base URL %q", baseURL)
	}
	if timeout <= 0 {
		return nil, fmt.Errorf("HTTP timeout must be positive")
	}
	return &osvClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		http:    &http.Client{Timeout: timeout},
	}, nil
}

type batchResponse struct {
	Results []osvResult `json:"results"`
}

type osvResult struct {
	Vulns         []vulnerabilityRef `json:"vulns"`
	NextPageToken string             `json:"next_page_token"`
}

type pendingQuery struct {
	resultIndex int
	query       osvQuery
}

func (c *osvClient) query(ctx context.Context, subjects []subject, batchSize, concurrency int) ([][]vulnerabilityRef, error) {
	if len(subjects) == 0 {
		return nil, fmt.Errorf("no packages to query")
	}
	if batchSize <= 0 {
		return nil, fmt.Errorf("batch size must be positive")
	}
	if concurrency <= 0 {
		return nil, fmt.Errorf("concurrency must be positive")
	}

	type batch struct {
		start   int
		queries []osvQuery
	}
	var batches []batch
	for start := 0; start < len(subjects); start += batchSize {
		end := min(start+batchSize, len(subjects))
		queries := make([]osvQuery, end-start)
		for index := start; index < end; index++ {
			if err := subjects[index].Query.validate(); err != nil {
				return nil, fmt.Errorf("%s: %w", subjects[index].Name, err)
			}
			queries[index-start] = subjects[index].Query
		}
		batches = append(batches, batch{start: start, queries: queries})
	}

	results := make([][]vulnerabilityRef, len(subjects))
	errorsByBatch := make([]error, len(batches))
	jobs := make(chan int, len(batches))
	for index := range batches {
		jobs <- index
	}
	close(jobs)

	workerCount := min(concurrency, len(batches))
	var workers sync.WaitGroup
	workers.Add(workerCount)
	for range workerCount {
		go func() {
			defer workers.Done()
			for index := range jobs {
				batchResults, err := c.queryBatch(ctx, batches[index].queries)
				if err != nil {
					errorsByBatch[index] = fmt.Errorf("OSV batch %d: %w", index+1, err)
					continue
				}
				copy(results[batches[index].start:], batchResults)
			}
		}()
	}
	workers.Wait()
	for _, err := range errorsByBatch {
		if err != nil {
			return nil, err
		}
	}
	return results, nil
}

func (c *osvClient) queryBatch(ctx context.Context, queries []osvQuery) ([][]vulnerabilityRef, error) {
	results := make([][]vulnerabilityRef, len(queries))
	seenIDs := make([]map[string]struct{}, len(queries))
	seenTokens := make([]map[string]struct{}, len(queries))
	pending := make([]pendingQuery, len(queries))
	for index, query := range queries {
		seenIDs[index] = make(map[string]struct{})
		seenTokens[index] = make(map[string]struct{})
		pending[index] = pendingQuery{resultIndex: index, query: query}
	}

	for page := 0; len(pending) > 0; page++ {
		if page >= maxQueryPages {
			return nil, fmt.Errorf("pagination exceeded %d pages", maxQueryPages)
		}
		pageQueries := make([]osvQuery, len(pending))
		for index := range pending {
			pageQueries[index] = pending[index].query
		}
		var response batchResponse
		if err := c.doJSON(ctx, http.MethodPost, "querybatch", struct {
			Queries []osvQuery `json:"queries"`
		}{Queries: pageQueries}, &response); err != nil {
			return nil, err
		}
		if response.Results == nil {
			return nil, fmt.Errorf("response is missing results")
		}
		if len(response.Results) != len(pending) {
			return nil, fmt.Errorf("response contains %d results for %d queries", len(response.Results), len(pending))
		}

		next := make([]pendingQuery, 0)
		for index, responseResult := range response.Results {
			original := pending[index].resultIndex
			for _, vuln := range responseResult.Vulns {
				if vuln.ID == "" {
					return nil, fmt.Errorf("query %d returned a vulnerability with no id", original+1)
				}
				if _, duplicate := seenIDs[original][vuln.ID]; duplicate {
					continue
				}
				seenIDs[original][vuln.ID] = struct{}{}
				results[original] = append(results[original], vuln)
			}
			if responseResult.NextPageToken == "" {
				continue
			}
			if _, repeated := seenTokens[original][responseResult.NextPageToken]; repeated {
				return nil, fmt.Errorf("query %d repeated a pagination token", original+1)
			}
			seenTokens[original][responseResult.NextPageToken] = struct{}{}
			query := pending[index].query
			query.PageToken = responseResult.NextPageToken
			next = append(next, pendingQuery{resultIndex: original, query: query})
		}
		pending = next
	}
	return results, nil
}

func (c *osvClient) fetchVulnerabilities(ctx context.Context, queryResults [][]vulnerabilityRef, concurrency int) (map[string]vulnerability, error) {
	ids := make(map[string]struct{})
	for _, result := range queryResults {
		for _, reference := range result {
			ids[reference.ID] = struct{}{}
		}
	}
	orderedIDs := make([]string, 0, len(ids))
	for id := range ids {
		orderedIDs = append(orderedIDs, id)
	}
	sort.Strings(orderedIDs)
	if len(orderedIDs) == 0 {
		return map[string]vulnerability{}, nil
	}
	if concurrency <= 0 {
		return nil, fmt.Errorf("concurrency must be positive")
	}

	items := make([]vulnerability, len(orderedIDs))
	errorsByID := make([]error, len(orderedIDs))
	jobs := make(chan int, len(orderedIDs))
	for index := range orderedIDs {
		jobs <- index
	}
	close(jobs)

	workerCount := min(concurrency, len(orderedIDs))
	var workers sync.WaitGroup
	workers.Add(workerCount)
	for range workerCount {
		go func() {
			defer workers.Done()
			for index := range jobs {
				var item vulnerability
				if err := c.doJSON(ctx, http.MethodGet, "vulns/"+url.PathEscape(orderedIDs[index]), nil, &item); err != nil {
					errorsByID[index] = fmt.Errorf("fetch %s: %w", orderedIDs[index], err)
					continue
				}
				if item.ID == "" {
					errorsByID[index] = fmt.Errorf("fetch %s: response has no id", orderedIDs[index])
					continue
				}
				items[index] = item
			}
		}()
	}
	workers.Wait()

	result := make(map[string]vulnerability, len(orderedIDs))
	for index, err := range errorsByID {
		if err != nil {
			return nil, err
		}
		result[orderedIDs[index]] = items[index]
	}
	return result, nil
}

func (c *osvClient) doJSON(ctx context.Context, method, endpoint string, requestBody, responseBody any) error {
	var encoded []byte
	var err error
	if requestBody != nil {
		encoded, err = json.Marshal(requestBody)
		if err != nil {
			return fmt.Errorf("encode request: %w", err)
		}
	}
	requestURL := c.baseURL + "/" + endpoint

	for attempt := 0; attempt < requestAttempts; attempt++ {
		request, err := http.NewRequestWithContext(ctx, method, requestURL, bytes.NewReader(encoded))
		if err != nil {
			return fmt.Errorf("create request: %w", err)
		}
		request.Header.Set("Accept", "application/json")
		request.Header.Set("User-Agent", "depot-3p-osv/1")
		if requestBody != nil {
			request.Header.Set("Content-Type", "application/json")
		}

		response, err := c.http.Do(request)
		if err != nil {
			if attempt+1 < requestAttempts && ctx.Err() == nil {
				if err := sleepContext(ctx, time.Duration(1<<attempt)*250*time.Millisecond); err != nil {
					return err
				}
				continue
			}
			return fmt.Errorf("%s %s: %w", method, requestURL, err)
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
		closeErr := response.Body.Close()
		if readErr != nil {
			return fmt.Errorf("read %s: %w", requestURL, readErr)
		}
		if closeErr != nil {
			return fmt.Errorf("close %s response: %w", requestURL, closeErr)
		}
		if len(body) > maxResponseBytes {
			return fmt.Errorf("%s response exceeds %d bytes", requestURL, maxResponseBytes)
		}

		if response.StatusCode < 200 || response.StatusCode >= 300 {
			if isTransientStatus(response.StatusCode) && attempt+1 < requestAttempts {
				delay := retryDelay(response.Header.Get("Retry-After"), attempt)
				if err := sleepContext(ctx, delay); err != nil {
					return err
				}
				continue
			}
			message := strings.TrimSpace(string(body))
			if len(message) > 512 {
				message = message[:512] + "..."
			}
			if message == "" {
				message = response.Status
			}
			return fmt.Errorf("%s %s returned HTTP %d: %s", method, requestURL, response.StatusCode, message)
		}
		if err := json.Unmarshal(body, responseBody); err != nil {
			return fmt.Errorf("decode %s response: %w", requestURL, err)
		}
		return nil
	}
	return fmt.Errorf("%s %s exhausted retries", method, requestURL)
}

func isTransientStatus(status int) bool {
	return status == http.StatusTooManyRequests || status >= 500
}

func retryDelay(header string, attempt int) time.Duration {
	if seconds, err := strconv.Atoi(header); err == nil && seconds >= 0 {
		return min(time.Duration(seconds)*time.Second, 10*time.Second)
	}
	if when, err := http.ParseTime(header); err == nil {
		return max(0, min(time.Until(when), 10*time.Second))
	}
	return time.Duration(1<<attempt) * 250 * time.Millisecond
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
