package main

import (
	"testing"
)

// makeTestLine builds a minimal Line with 3 stations and a buildable schedule
// for use across position tests.
func makeTestLine() *Line {
	stns := []station{
		{Name: "A", Lat: 41.0, Lng: 29.00},
		{Name: "B", Lat: 41.0, Lng: 29.05},
		{Name: "C", Lat: 41.0, Lng: 29.10},
	}
	tripDur := 600.0
	return &Line{
		Code:            "M1",
		Name:            "Test",
		Kind:            "metro",
		stations:        stns,
		headwaySec:      300,
		tripDurationSec: tripDur,
		trainCount:      4,
		schedule:        buildTripSchedule(stns, tripDur),
	}
}

func TestPositionsForBadConfig(t *testing.T) {
	if (&Line{}).PositionsFor(0) != nil {
		t.Fatal("expected nil for zero config")
	}
	l := &Line{headwaySec: 60, tripDurationSec: 60, trainCount: 1}
	if l.PositionsFor(0) != nil {
		t.Fatal("expected nil for empty stations")
	}
}

func TestPositionsForCycleZero(t *testing.T) {
	// trainCount > 0 and headwaySec > 0 but cycle goes negative — actually
	// impossible without negatives. Cover the negative-phase branch instead.
	l := makeTestLine()
	out := l.PositionsFor(-100000)
	if len(out) != l.trainCount {
		t.Fatalf("got %d trains", len(out))
	}
}

func TestPositionsForDirections(t *testing.T) {
	l := makeTestLine()
	// We want to hit each branch of the switch. With trainCount=4 and headway=300,
	// cycle=1200, half=600, tripDur=600 (clamped to half=600 → no terminal
	// dwell at all). Build a line with longer half-cycle so we exercise all
	// four branches.
	l.headwaySec = 600
	l.trainCount = 4 // cycle=2400, half=1200, tripDur=600
	l.schedule = buildTripSchedule(l.stations, l.tripDurationSec)
	out := l.PositionsFor(0)
	if len(out) != 4 {
		t.Fatalf("trains = %d", len(out))
	}
	directions := map[string]int{}
	for _, p := range out {
		directions[p.Direction]++
	}
	// Trains are phase-offset by headway=600 over cycle=2400 → phases at
	// 0, 600, 1200, 1800. That puts them in ab (0..tripDur=600), B-dwell
	// (600..1200), ba (1200..1800), A-dwell (1800..2400).
	if directions["ab"] == 0 || directions["ba"] == 0 || directions["dwell"] == 0 {
		t.Fatalf("missing directions: %+v", directions)
	}
}

func TestPositionsForFromToAndProgress(t *testing.T) {
	l := makeTestLine()
	l.headwaySec = 600
	l.trainCount = 4
	l.schedule = buildTripSchedule(l.stations, l.tripDurationSec)
	// At t=100, train 0 is mid travel A→B (well before the dwell at B).
	out := l.PositionsFor(100)
	got := out[0]
	if got.Direction != "ab" {
		t.Fatalf("got direction %q", got.Direction)
	}
	if got.FromStation == "" || got.ToStation == "" {
		t.Fatalf("missing names: %+v", got)
	}
	if got.SecondsToNext < 0 {
		t.Fatalf("secondsToNext < 0: %v", got.SecondsToNext)
	}
}

func TestPositionsForBABranchDwell(t *testing.T) {
	// Force a B→A leg to land on a dwell segment so segFrac=0 path runs.
	stns := []station{
		{Name: "A", Lat: 41.0, Lng: 29.00},
		{Name: "B", Lat: 41.0, Lng: 29.05},
		{Name: "C", Lat: 41.0, Lng: 29.10},
	}
	tripDur := 600.0
	l := &Line{
		stations:        stns,
		headwaySec:      1200,
		tripDurationSec: tripDur,
		trainCount:      2, // cycle=2400, half=1200
		schedule:        buildTripSchedule(stns, tripDur),
	}
	// Find time when train 0 is on B→A leg AND in a dwell segment.
	// schedule layout (tripDur=600, 1 intermediate, dwell=20):
	// seg0 travel a→b 0..290
	// seg1 dwell b 290..310
	// seg2 travel b→c 310..600
	// For ba leg starting at phase=half=1200, tripT = phase-1200.
	// We look up segmentAtTripTime(tripDur - tripT) = segmentAtTripTime(600 - tripT).
	// To land in dwell seg1 (290..310 in trip time), need 600-tripT in [290,310]
	// → tripT in [290,310] → phase in [1490,1510].
	out := l.PositionsFor(1500)
	got := out[0]
	if got.Direction != "dwell" {
		t.Fatalf("expected dwell, got %+v", got)
	}
	if got.FromStation != got.ToStation {
		t.Fatalf("expected same names, got %+v", got)
	}
	if got.SegmentProgress != 0 {
		t.Fatalf("expected segFrac=0, got %v", got.SegmentProgress)
	}
}

func TestPositionsForBABranchTravel(t *testing.T) {
	stns := []station{
		{Name: "A", Lat: 41.0, Lng: 29.00},
		{Name: "B", Lat: 41.0, Lng: 29.10},
	}
	tripDur := 600.0
	l := &Line{
		stations:        stns,
		headwaySec:      1200,
		tripDurationSec: tripDur,
		trainCount:      2,
		schedule:        buildTripSchedule(stns, tripDur),
	}
	// phase = 1500 → tripT = 300 → segmentAtTripTime(300) sits inside travel.
	out := l.PositionsFor(1500)
	got := out[0]
	if got.Direction != "ba" {
		t.Fatalf("expected ba, got %+v", got)
	}
	if got.FromStation != "B" || got.ToStation != "A" {
		t.Fatalf("expected B→A, got %v→%v", got.FromStation, got.ToStation)
	}
	if got.SegmentProgress <= 0 || got.SegmentProgress >= 1 {
		t.Fatalf("segFrac = %v", got.SegmentProgress)
	}
}

func TestPositionsForADwell(t *testing.T) {
	stns := []station{
		{Name: "A", Lat: 41.0, Lng: 29.00},
		{Name: "B", Lat: 41.0, Lng: 29.05},
	}
	tripDur := 600.0
	l := &Line{
		stations:        stns,
		headwaySec:      1200,
		tripDurationSec: tripDur,
		trainCount:      2, // cycle=2400, half=1200
		schedule:        buildTripSchedule(stns, tripDur),
	}
	// half+tripDur = 1800 → A-dwell branch is phase in [1800, 2400).
	out := l.PositionsFor(2000)
	got := out[0]
	if got.Direction != "dwell" {
		t.Fatalf("expected dwell, got %+v", got)
	}
	if got.FromStation != "A" || got.ToStation != "A" {
		t.Fatalf("expected A,A, got %v,%v", got.FromStation, got.ToStation)
	}
}

func TestPositionsForBDwell(t *testing.T) {
	stns := []station{
		{Name: "A", Lat: 41.0, Lng: 29.00},
		{Name: "B", Lat: 41.0, Lng: 29.05},
	}
	tripDur := 600.0
	l := &Line{
		stations:        stns,
		headwaySec:      1200,
		tripDurationSec: tripDur,
		trainCount:      2, // cycle=2400, half=1200
		schedule:        buildTripSchedule(stns, tripDur),
	}
	// tripDur..half is 600..1200 → B-dwell.
	out := l.PositionsFor(900)
	got := out[0]
	if got.Direction != "dwell" {
		t.Fatalf("expected dwell, got %+v", got)
	}
	if got.FromStation != "B" || got.ToStation != "B" {
		t.Fatalf("expected B,B, got %v,%v", got.FromStation, got.ToStation)
	}
}

func TestPositionsForTripClampedAtHalf(t *testing.T) {
	// When tripDur > half (cycle/2), positions still compute (clamped).
	stns := []station{
		{Name: "A", Lat: 41.0, Lng: 29.00},
		{Name: "B", Lat: 41.0, Lng: 29.05},
	}
	tripDur := 9999.0
	l := &Line{
		stations:        stns,
		headwaySec:      60,
		tripDurationSec: tripDur,
		trainCount:      2,
		schedule:        buildTripSchedule(stns, 60), // half-cycle = 60
	}
	out := l.PositionsFor(0)
	if len(out) != 2 {
		t.Fatalf("trains = %d", len(out))
	}
}

func TestStationNamesForwardReverseDwell(t *testing.T) {
	stns := []station{{Name: "A"}, {Name: "B"}}
	seg := tripSegment{startIdx: 0, endIdx: 1}
	if f, to := stationNames(stns, seg, false); f != "A" || to != "B" {
		t.Fatalf("fwd: %v %v", f, to)
	}
	if f, to := stationNames(stns, seg, true); f != "B" || to != "A" {
		t.Fatalf("rev: %v %v", f, to)
	}
	dwell := tripSegment{startIdx: 0, endIdx: 0}
	if f, to := stationNames(stns, dwell, false); f != "A" || to != "A" {
		t.Fatalf("dwell: %v %v", f, to)
	}
}

func TestPositionsForIntermediateDwellCoercedToDwell(t *testing.T) {
	// When from == to but direction is "ab", the function coerces to "dwell".
	// To force this we set a schedule whose ab branch returns a dwell segment.
	stns := []station{
		{Name: "A", Lat: 41.0, Lng: 29.00},
		{Name: "B", Lat: 41.0, Lng: 29.05},
		{Name: "C", Lat: 41.0, Lng: 29.10},
	}
	tripDur := 600.0
	sched := buildTripSchedule(stns, tripDur)
	// Locate the dwell-at-B segment and pick a phase inside it.
	var dwellMid float64
	for _, s := range sched {
		if s.startIdx == s.endIdx {
			dwellMid = (s.startSec + s.endSec) / 2
			break
		}
	}
	l := &Line{
		stations:        stns,
		headwaySec:      1200,
		tripDurationSec: tripDur,
		trainCount:      2,
		schedule:        sched,
	}
	out := l.PositionsFor(dwellMid)
	if out[0].Direction != "dwell" {
		t.Fatalf("expected coerced dwell, got %+v", out[0])
	}
}

func TestPositionsForNegativeSecondsClamped(t *testing.T) {
	// Build a deliberately-malformed schedule whose last segment ends well
	// before tripDurationSec, so segmentAtTripTime returns (last, frac=1) and
	// secsToNext = seg.endSec - phase goes negative. The PositionsFor clamp
	// to zero is what we want to exercise.
	stns := []station{
		{Name: "A", Lat: 41.0, Lng: 29.00},
		{Name: "B", Lat: 41.0, Lng: 29.05},
	}
	l := &Line{
		stations:        stns,
		headwaySec:      1200,
		tripDurationSec: 500,
		trainCount:      2,
		schedule:        []tripSegment{{startSec: 0, endSec: 10, startIdx: 0, endIdx: 1}},
	}
	// phase=100 is < tripDur=500 (ab branch), > last.endSec=10. segmentAtTripTime
	// returns last with frac=1, so secsToNext = 10 - 100 = -90, then clamped.
	out := l.PositionsFor(100)
	for _, p := range out {
		if p.SecondsToNext < 0 {
			t.Fatalf("negative SecondsToNext: %+v", p)
		}
	}
}
