package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// DisruptionItem is the adapted, client-ready shape returned by
// GET /v1/disruptions. The backend owns line-code normalization, type and
// severity inference, and title formatting so the client doesn't need a
// Turkish-keyword classifier (or a direct IBB connection) at all.
//
// stations is deliberately left to the client because resolving names to
// StationNode entries depends on the per-line station list the client has
// already loaded into its routing graph.
type DisruptionItem struct {
	ID          string  `json:"id"`
	LineCode    string  `json:"lineCode"`
	Severity    string  `json:"severity"`
	Type        string  `json:"type"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	StartTime   *string `json:"startTime,omitempty"`
	EndTime     *string `json:"endTime,omitempty"`
}

// metroAPIURL is the IBB Metro Istanbul service-status endpoint. It's
// genuinely slow (8-12s typical, occasional 20s+), so the client used to take
// the hit on every load — now the backend polls in the background and serves
// the cached result instantly.
const metroAPIURL = "https://api.ibb.gov.tr/MetroIstanbul/api/MetroMobile/V2/GetServiceStatuses"

// DisruptionsService owns the polling loop and the cached snapshot. It's safe
// for concurrent reads + a single writer; the mutex guards both.
type DisruptionsService struct {
	url      string
	client   *http.Client
	interval time.Duration

	mu        sync.RWMutex
	items     []DisruptionItem
	fetchedAt time.Time
	lastErr   string
}

func NewDisruptionsService(interval time.Duration) *DisruptionsService {
	return &DisruptionsService{
		url:      metroAPIURL,
		// IBB's gateway routinely takes 8-12s and occasionally pushes 30s+.
		// Generous timeout here is fine — the ticker keeps retrying anyway.
		client:   &http.Client{Timeout: 45 * time.Second},
		interval: interval,
	}
}

// Snapshot returns the cached items, the time they were fetched, and the
// most recent error string (empty when the last fetch succeeded). Callers
// must treat the returned slice as read-only.
func (s *DisruptionsService) Snapshot() ([]DisruptionItem, time.Time, string) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.items, s.fetchedAt, s.lastErr
}

// Start kicks off a polling goroutine that refreshes the cache on `interval`
// until ctx is cancelled. The first fetch happens immediately so /v1/disruptions
// has something to serve right after boot.
func (s *DisruptionsService) Start(ctx context.Context) {
	go func() {
		s.refresh(ctx)
		t := time.NewTicker(s.interval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.refresh(ctx)
			}
		}
	}()
}

func (s *DisruptionsService) refresh(ctx context.Context) {
	start := time.Now()
	items, err := s.fetchAndAdapt(ctx)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		// Keep the previous snapshot — a transient IBB outage shouldn't
		// erase what we already have. Record the error and log it so
		// operators can see when IBB is misbehaving without scraping
		// /v1/disruptions for the lastErr field.
		s.lastErr = err.Error()
		log.Printf("disruptions refresh failed after %s: %v", time.Since(start).Round(time.Millisecond), err)
		return
	}
	s.items = items
	s.fetchedAt = time.Now().UTC()
	s.lastErr = ""
	log.Printf("disruptions refreshed in %s · %d active", time.Since(start).Round(time.Millisecond), len(items))
}

func (s *DisruptionsService) fetchAndAdapt(ctx context.Context) ([]DisruptionItem, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ibb fetch: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// Drain a small chunk so the connection can be reused.
		_, _ = io.CopyN(io.Discard, resp.Body, 1024)
		return nil, fmt.Errorf("ibb http %d", resp.StatusCode)
	}

	var body metroAPIResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("ibb decode: %w", err)
	}
	if !body.Success {
		return nil, fmt.Errorf("ibb success=false: %v", body.Error)
	}

	out := make([]DisruptionItem, 0, len(body.Data))
	for _, item := range body.Data {
		if !item.IsActive {
			continue
		}
		desc := strings.TrimSpace(item.Description)
		if desc == "" {
			continue
		}
		out = append(out, adaptServiceStatus(item, desc))
	}
	return out, nil
}

type metroAPIResponse struct {
	Success bool             `json:"Success"`
	Error   any              `json:"Error"`
	Data    []metroAPIRecord `json:"Data"`
}

type metroAPIRecord struct {
	LineID                int    `json:"LineId"`
	LineName              string `json:"LineName"`
	Description           string `json:"Description"`
	IsActive              bool   `json:"IsActive"`
	UpdateDate            string `json:"UpdateDate"`
	LineLongDescription   string `json:"LineLongDescription"`
	LineShortDescription  string `json:"LineShortDescription"`
}

func adaptServiceStatus(item metroAPIRecord, description string) DisruptionItem {
	lineCode := normalizeLineCode(item.LineName)
	dtype := inferType(description)
	severity := inferSeverity(description, dtype)
	start := normalizeTime(item.UpdateDate)
	return DisruptionItem{
		ID:          fmt.Sprintf("metro-%d-%s", item.LineID, item.UpdateDate),
		LineCode:    lineCode,
		Severity:    severity,
		Type:        dtype,
		Title:       titleFor(dtype, item),
		Description: description,
		StartTime:   start,
		EndTime:     nil,
	}
}

// lineCodeRe matches the canonical prefix in whatever string IBB shoves into
// `LineName`. Real-world values include "M7", "M7 Hattı", "Marmaray",
// "T1 Bağcılar-Kabataş", … — the client's data keys these as "M7", "T1",
// "Marmaray", etc.
var lineCodeRe = regexp.MustCompile(`(?i)^(M\d{1,2}[AB]?|T\d{1,2}|F\d{1,2}|Marmaray)\b`)

func normalizeLineCode(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	m := lineCodeRe.FindStringSubmatch(s)
	if m == nil {
		return s
	}
	token := m[1]
	if strings.EqualFold(token, "marmaray") {
		return "Marmaray"
	}
	return strings.ToUpper(token)
}

func normalizeTime(s string) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	// IBB stamps Istanbul local time without a timezone. Add +03:00 so JS
	// Date and time.Parse interpret it the same way.
	if hasTimezone(s) {
		return &s
	}
	withTZ := s + "+03:00"
	return &withTZ
}

var tzSuffixRe = regexp.MustCompile(`[zZ]$|[+-]\d{2}:?\d{2}$`)

func hasTimezone(s string) bool {
	return tzSuffixRe.MatchString(s)
}

func titleFor(dtype string, item metroAPIRecord) string {
	line := strings.TrimSpace(item.LineLongDescription)
	if line == "" {
		line = strings.TrimSpace(item.LineShortDescription)
	}
	if line == "" {
		line = item.LineName
	}
	return fmt.Sprintf("%s — %s", line, typeLabel(dtype))
}

func typeLabel(dtype string) string {
	switch dtype {
	case "closure":
		return "Closure"
	case "delay":
		return "Delay"
	case "maintenance":
		return "Maintenance"
	case "repair":
		return "Repair"
	default:
		return "Incident"
	}
}

// Turkish keyword classification. Mirrors src/disruptions.ts's heuristics —
// the regexes match the same word stems (kapalı/iptal → closure, onarım/tamir
// → repair, bakım/çalışma/yenile/revizyon → maintenance, gecikme/geç/yavaş →
// delay, arıza/kaza → incident).
var (
	closureRe     = regexp.MustCompile(`(?i)\b(kapal[ıi]|kapat[ıi]l|iptal|servis d[ıi][şs][ıi])\b`)
	repairRe      = regexp.MustCompile(`(?i)\b(onar[ıi]m|tamir)\b`)
	maintenanceRe = regexp.MustCompile(`(?i)\b(bak[ıi]m|çal[ıi][şs]ma|yenile|revizyon)\b`)
	delayRe       = regexp.MustCompile(`(?i)\b(gecikme|geç|yavaş)\b`)
	incidentRe    = regexp.MustCompile(`(?i)\b(ar[ıi]za|kaza)\b`)
	bigDelayRe    = regexp.MustCompile(`(?i)\b(uzun|büyük)\b`)
)

func inferType(text string) string {
	t := strings.ToLower(text)
	switch {
	case closureRe.MatchString(t):
		return "closure"
	case repairRe.MatchString(t):
		return "repair"
	case maintenanceRe.MatchString(t):
		return "maintenance"
	case delayRe.MatchString(t):
		return "delay"
	case incidentRe.MatchString(t):
		return "incident"
	default:
		return "incident"
	}
}

func inferSeverity(text, dtype string) string {
	t := strings.ToLower(text)
	if dtype == "closure" || closureRe.MatchString(t) {
		return "critical"
	}
	if dtype == "delay" && !bigDelayRe.MatchString(t) {
		return "info"
	}
	return "warning"
}
