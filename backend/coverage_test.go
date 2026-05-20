package main

import (
	"encoding/json"
	"flag"
	"net"
	"net/http/httptest"
	"os"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// TestStitchLaterSegmentLonger triggers the "later segment beats seed length"
// branch when picking the stitch seed.
func TestStitchLaterSegmentLonger(t *testing.T) {
	short := []point{{lng: 0, lat: 0}, {lng: 0, lat: 0.0001}}
	long := []point{{lng: 50, lat: 50}, {lng: 50, lat: 50.01}}
	pl := stitch([][]point{short, long})
	// Seed should be the long segment.
	if !approxEqual(pl.length(), segmentLength(long), 1) {
		t.Fatalf("expected long-seed length, got %v", pl.length())
	}
}

// TestAddBridgeEdgesSkipFarVertices covers the d > bridgeTolMetres bypass: two
// vertices in adjacent buckets but farther apart than the bridge tolerance.
func TestAddBridgeEdgesSkipFarVertices(t *testing.T) {
	// Vertices ~40m apart (well past 25m bridge tol) but inside neighboring
	// buckets. bucketSizeDeg ≈ 50m, so 40m lat ≈ 0.00036°.
	segs := [][]point{
		{{lng: 29.0, lat: 41.0}, {lng: 29.0, lat: 41.00001}},
		{{lng: 29.0, lat: 41.00036}, {lng: 29.0, lat: 41.00038}},
	}
	g := buildVertexGraph(segs)
	// shortestPath between disconnected components must be unreachable.
	if path := g.shortestPath(0, 2); path != nil {
		t.Fatalf("expected unreachable, got %+v", path)
	}
}

// TestShortestPathStalePoppedBeforeDest ensures the stale-entry continue path
// executes by routing the destination beyond the node whose stale heap entry
// must be popped first.
func TestShortestPathStalePoppedBeforeDest(t *testing.T) {
	// Nodes: 0,1,2,3,4. to=4. Path of decreasing weight to 1 lands a stale
	// {1, 10} entry that must be popped after {1, 2}, before 4 is reached.
	g := vertexGraph{
		verts: []vertex{
			{pt: point{}},
			{pt: point{lng: 1}},
			{pt: point{lng: 2}},
			{pt: point{lng: 3}},
			{pt: point{lng: 4}},
		},
		adj: [][]graphEdge{
			{{to: 1, weight: 10}, {to: 2, weight: 1}},
			{{to: 0, weight: 10}, {to: 2, weight: 1}, {to: 3, weight: 10}},
			{{to: 0, weight: 1}, {to: 1, weight: 1}},
			{{to: 1, weight: 10}, {to: 4, weight: 1}},
			{{to: 3, weight: 1}},
		},
	}
	got := g.shortestPath(0, 4)
	// Expected shortest: 0→2→1→3→4 = 1+1+10+1 = 13.
	if len(got) != 5 {
		t.Fatalf("got %+v", got)
	}
}

// TestRenderLinePathDetourFallback forces bestPathBetween onto the
// pathM > directM*1.8+150 fallback branch.
func TestRenderLinePathDetourFallback(t *testing.T) {
	// Long graph detour but very short straight distance — A and B are 0.0001°
	// apart in latitude (~11m) but the graph forces a multi-km detour.
	segs := [][]point{
		{
			{lng: 29.0, lat: 41.0},
			{lng: 29.01, lat: 41.0},
			{lng: 29.01, lat: 41.02},
			{lng: 29.0, lat: 41.02},
			{lng: 29.0, lat: 41.0005},
		},
	}
	stns := []station{
		{Name: "A", Lat: 41.0, Lng: 29.0},
		{Name: "B", Lat: 41.0005, Lng: 29.0},
	}
	got := renderLinePath(stns, segs)
	if len(got) != 2 {
		t.Fatalf("expected straight fallback, got %d points", len(got))
	}
}

// TestHandleLinesSortMultiple covers the sort comparator with more than one
// line so the Less function actually runs.
func TestHandleLinesSortMultiple(t *testing.T) {
	mkLine := func(code string) *Line {
		stns := []station{
			{Name: "a", Lat: 41.0, Lng: 29.0},
			{Name: "b", Lat: 41.05, Lng: 29.0},
		}
		return &Line{
			Code:            code,
			stations:        stns,
			pl:              makePolyline([]point{{lng: 29.0, lat: 41.0}, {lng: 29.0, lat: 41.05}}),
			headwaySec:      300,
			tripDurationSec: 600,
			trainCount:      4,
			schedule:        buildTripSchedule(stns, 600),
			renderedPath:    [][2]float64{{29.0, 41.0}, {29.0, 41.05}},
		}
	}
	s := NewServer(map[string]*Line{
		"M2": mkLine("M2"),
		"M1": mkLine("M1"),
	}, NewDisruptionsService(time.Minute), "*")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/v1/lines", nil)
	s.Handler().ServeHTTP(rec, req)
	var out []lineSummary
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 || out[0].Code != "M1" || out[1].Code != "M2" {
		t.Fatalf("not sorted: %+v", out)
	}

	rec = httptest.NewRecorder()
	req = httptest.NewRequest("GET", "/v1/lines/geometry", nil)
	s.Handler().ServeHTTP(rec, req)
	var geo []lineGeometry
	if err := json.Unmarshal(rec.Body.Bytes(), &geo); err != nil {
		t.Fatal(err)
	}
	if len(geo) != 2 || geo[0].Code != "M1" || geo[1].Code != "M2" {
		t.Fatalf("geo not sorted: %+v", geo)
	}
}

// TestMainSmoke calls main() inside the test binary so coverage tracks the
// startup/shutdown path. We seed a valid data dir, pick a free port, then send
// SIGTERM after a brief delay to trigger graceful shutdown.
func TestMainSmoke(t *testing.T) {
	h, l, s := makeSimpleFC()
	dir := writeDataDir(t, h, l, s)

	// Grab a free port so two test runs don't collide.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	addr := "127.0.0.1:" + strconv.Itoa(port)

	// main() reads from flag.CommandLine; replace os.Args and reset the
	// default flag set so re-parsing is clean.
	origArgs := os.Args
	origFS := flag.CommandLine
	defer func() {
		os.Args = origArgs
		flag.CommandLine = origFS
	}()
	flag.CommandLine = flag.NewFlagSet(origArgs[0], flag.ExitOnError)
	// disruptions-poll well beyond our shutdown window so polling is at most
	// the initial refresh, which fails fast against the unreachable IBB URL.
	os.Args = []string{
		"livepos",
		"-data", dir,
		"-addr", addr,
		"-disruptions-poll", "1h",
	}

	// Trigger SIGTERM shortly so main returns from <-ctx.Done().
	go func() {
		time.Sleep(300 * time.Millisecond)
		proc, _ := os.FindProcess(os.Getpid())
		_ = proc.Signal(syscall.SIGTERM)
	}()

	done := make(chan struct{})
	go func() {
		main()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("main did not return")
	}
}

