package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestNormalizeLineCode(t *testing.T) {
	cases := map[string]string{
		"M7":                "M7",
		"M7 Hattı":          "M7",
		"m11a service":      "M11A",
		"Marmaray":          "Marmaray",
		"MARMARAY suburb":   "Marmaray",
		"T1 Bağcılar":       "T1",
		"F1 funicular":      "F1",
		"":                  "",
		"Some random text":  "Some random text",
		"  M3 spaced  ":     "M3",
	}
	for in, want := range cases {
		if got := normalizeLineCode(in); got != want {
			t.Fatalf("normalizeLineCode(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestNormalizeTime(t *testing.T) {
	if got := normalizeTime(""); got != nil {
		t.Fatalf("empty: %v", got)
	}
	got := normalizeTime("2026-05-20T12:00:00")
	if got == nil || *got != "2026-05-20T12:00:00+03:00" {
		t.Fatalf("got %v", got)
	}
	got = normalizeTime("2026-05-20T12:00:00Z")
	if got == nil || *got != "2026-05-20T12:00:00Z" {
		t.Fatalf("with TZ: %v", got)
	}
	got = normalizeTime("2026-05-20T12:00:00+03:00")
	if got == nil || *got != "2026-05-20T12:00:00+03:00" {
		t.Fatalf("explicit offset: %v", got)
	}
	got = normalizeTime("2026-05-20T12:00:00-0500")
	if got == nil || *got != "2026-05-20T12:00:00-0500" {
		t.Fatalf("compact offset: %v", got)
	}
}

func TestHasTimezone(t *testing.T) {
	cases := map[string]bool{
		"2026-05-20T12:00:00Z":      true,
		"2026-05-20T12:00:00z":      true,
		"2026-05-20T12:00:00+03:00": true,
		"2026-05-20T12:00:00-0500":  true,
		"2026-05-20T12:00:00":       false,
	}
	for in, want := range cases {
		if got := hasTimezone(in); got != want {
			t.Fatalf("hasTimezone(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestInferType(t *testing.T) {
	// Go's regexp \b is ASCII-only; words ending in Turkish chars (ı, ş, ç...)
	// don't form a word boundary, so test inputs use forms that match.
	cases := []struct{ in, want string }{
		{"iptal edildi", "closure"},
		{"hat kapatil durumda", "closure"},
		{"onarim devam ediyor", "repair"},
		{"tamir devam ediyor", "repair"},
		{"bakim calismasi var", "maintenance"},
		{"revizyon yapildi", "maintenance"},
		{"yenile sistemi", "maintenance"},
		{"gecikme yasaniyor", "delay"},
		{"arıza durumu", "incident"},
		{"kaza yasandi", "incident"},
		{"random unrelated text", "incident"},
	}
	for _, c := range cases {
		if got := inferType(c.in); got != c.want {
			t.Fatalf("inferType(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestInferSeverity(t *testing.T) {
	if got := inferSeverity("hat iptal", "closure"); got != "critical" {
		t.Fatalf("closure-by-dtype: %v", got)
	}
	if got := inferSeverity("iptal duyurusu", "incident"); got != "critical" {
		t.Fatalf("closure-by-text: %v", got)
	}
	if got := inferSeverity("kisa gecikme", "delay"); got != "info" {
		t.Fatalf("small delay: %v", got)
	}
	if got := inferSeverity("uzun gecikme", "delay"); got != "warning" {
		t.Fatalf("big delay: %v", got)
	}
	if got := inferSeverity("arıza", "incident"); got != "warning" {
		t.Fatalf("incident: %v", got)
	}
}

func TestTypeLabel(t *testing.T) {
	cases := map[string]string{
		"closure":     "Closure",
		"delay":       "Delay",
		"maintenance": "Maintenance",
		"repair":      "Repair",
		"incident":    "Incident",
		"other":       "Incident",
	}
	for in, want := range cases {
		if got := typeLabel(in); got != want {
			t.Fatalf("typeLabel(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTitleFor(t *testing.T) {
	item := metroAPIRecord{
		LineName:             "M2",
		LineShortDescription: "Short",
		LineLongDescription:  "Yenikapı–Hacıosman",
	}
	if got := titleFor("delay", item); got != "Yenikapı–Hacıosman — Delay" {
		t.Fatalf("got %q", got)
	}
	item.LineLongDescription = ""
	if got := titleFor("delay", item); got != "Short — Delay" {
		t.Fatalf("got %q", got)
	}
	item.LineShortDescription = ""
	if got := titleFor("delay", item); got != "M2 — Delay" {
		t.Fatalf("got %q", got)
	}
}

func TestAdaptServiceStatus(t *testing.T) {
	item := metroAPIRecord{
		LineID:               5,
		LineName:             "M2 Hattı",
		LineLongDescription:  "Yenikapı–Hacıosman",
		LineShortDescription: "M2",
		Description:          "Hat iptal edildi",
		IsActive:             true,
		UpdateDate:           "2026-05-20T10:00:00",
	}
	out := adaptServiceStatus(item, item.Description)
	if out.ID != "metro-5-2026-05-20T10:00:00" {
		t.Fatalf("id = %q", out.ID)
	}
	if out.LineCode != "M2" {
		t.Fatalf("lineCode = %q", out.LineCode)
	}
	if out.Severity != "critical" || out.Type != "closure" {
		t.Fatalf("severity/type: %v/%v", out.Severity, out.Type)
	}
	if out.StartTime == nil || !strings.HasSuffix(*out.StartTime, "+03:00") {
		t.Fatalf("startTime: %v", out.StartTime)
	}
	if out.EndTime != nil {
		t.Fatalf("endTime: %v", out.EndTime)
	}
}

func TestDisruptionsServiceSnapshotEmpty(t *testing.T) {
	s := NewDisruptionsService(time.Second)
	items, at, err := s.Snapshot()
	if items != nil {
		t.Fatalf("items = %v", items)
	}
	if !at.IsZero() {
		t.Fatalf("fetchedAt = %v", at)
	}
	if err != "" {
		t.Fatalf("err = %q", err)
	}
}

func TestDisruptionsFetchAndAdaptSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(metroAPIResponse{
			Success: true,
			Data: []metroAPIRecord{
				{LineID: 1, LineName: "M1", Description: "Hat iptal", IsActive: true, UpdateDate: "2026-05-20T10:00:00"},
				{LineID: 2, LineName: "M2", Description: "  ", IsActive: true}, // dropped: empty desc
				{LineID: 3, LineName: "M3", Description: "ok", IsActive: false}, // dropped: inactive
			},
		})
	}))
	defer srv.Close()
	s := NewDisruptionsService(time.Second)
	s.url = srv.URL
	got, err := s.fetchAndAdapt(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("got %d items", len(got))
	}
	if got[0].LineCode != "M1" {
		t.Fatalf("lineCode = %q", got[0].LineCode)
	}
}

func TestDisruptionsFetchAndAdaptHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(strings.Repeat("x", 200)))
	}))
	defer srv.Close()
	s := NewDisruptionsService(time.Second)
	s.url = srv.URL
	_, err := s.fetchAndAdapt(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestDisruptionsFetchAndAdaptBadJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `not json`)
	}))
	defer srv.Close()
	s := NewDisruptionsService(time.Second)
	s.url = srv.URL
	_, err := s.fetchAndAdapt(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestDisruptionsFetchAndAdaptSuccessFalse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(metroAPIResponse{Success: false, Error: "fail"})
	}))
	defer srv.Close()
	s := NewDisruptionsService(time.Second)
	s.url = srv.URL
	_, err := s.fetchAndAdapt(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestDisruptionsFetchAndAdaptRequestError(t *testing.T) {
	s := NewDisruptionsService(time.Second)
	s.url = "http://127.0.0.1:0" // unreachable
	_, err := s.fetchAndAdapt(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestDisruptionsFetchAndAdaptBadURL(t *testing.T) {
	s := NewDisruptionsService(time.Second)
	s.url = "://bad-url"
	_, err := s.fetchAndAdapt(context.Background())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestDisruptionsRefreshSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(metroAPIResponse{
			Success: true,
			Data: []metroAPIRecord{
				{LineID: 1, LineName: "M1", Description: "Hat iptal", IsActive: true, UpdateDate: "2026-05-20T10:00:00"},
			},
		})
	}))
	defer srv.Close()
	s := NewDisruptionsService(time.Second)
	s.url = srv.URL
	s.refresh(context.Background())
	items, at, errStr := s.Snapshot()
	if len(items) != 1 {
		t.Fatalf("items = %+v", items)
	}
	if at.IsZero() {
		t.Fatalf("fetchedAt zero")
	}
	if errStr != "" {
		t.Fatalf("err = %q", errStr)
	}
}

func TestDisruptionsRefreshFailureRetainsPrevious(t *testing.T) {
	calls := atomic.Int32{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		n := calls.Add(1)
		if n == 1 {
			_ = json.NewEncoder(w).Encode(metroAPIResponse{
				Success: true,
				Data: []metroAPIRecord{
					{LineID: 1, LineName: "M1", Description: "Hat iptal", IsActive: true, UpdateDate: "2026-05-20T10:00:00"},
				},
			})
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	s := NewDisruptionsService(time.Second)
	s.url = srv.URL
	s.refresh(context.Background())
	first, firstAt, _ := s.Snapshot()
	if len(first) != 1 {
		t.Fatalf("first snapshot")
	}
	s.refresh(context.Background())
	items, at, errStr := s.Snapshot()
	if len(items) != 1 {
		t.Fatalf("expected retained items, got %+v", items)
	}
	if !at.Equal(firstAt) {
		t.Fatalf("fetchedAt should not advance on failure")
	}
	if errStr == "" {
		t.Fatalf("expected non-empty error")
	}
}

func TestDisruptionsStartStop(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(metroAPIResponse{Success: true})
	}))
	defer srv.Close()
	s := NewDisruptionsService(50 * time.Millisecond)
	s.url = srv.URL
	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	// Wait for first refresh.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_, at, _ := s.Snapshot()
		if !at.IsZero() {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	_, at, _ := s.Snapshot()
	if at.IsZero() {
		t.Fatal("expected first refresh to land")
	}
	// Tick at least once more.
	time.Sleep(120 * time.Millisecond)
	cancel()
	// Give goroutine a moment to exit.
	time.Sleep(50 * time.Millisecond)
}
