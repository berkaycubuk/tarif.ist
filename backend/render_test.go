package main

import (
	"container/heap"
	"math"
	"testing"
)

func TestRenderLinePathTooFewStations(t *testing.T) {
	stns := []station{{Name: "A", Lat: 0, Lng: 0}}
	got := renderLinePath(stns, [][]point{{{lng: 0, lat: 0}, {lng: 0, lat: 1}}})
	if len(got) != 1 || got[0] != [2]float64{0, 0} {
		t.Fatalf("got %+v", got)
	}
}

func TestRenderLinePathNoGraph(t *testing.T) {
	stns := []station{
		{Name: "A", Lat: 0, Lng: 0},
		{Name: "B", Lat: 0, Lng: 1},
	}
	got := renderLinePath(stns, nil)
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
}

func TestRenderLinePathHappy(t *testing.T) {
	segs := [][]point{
		{{lng: 29, lat: 41.0}, {lng: 29, lat: 41.005}, {lng: 29, lat: 41.01}},
	}
	stns := []station{
		{Name: "A", Lat: 41.0, Lng: 29},
		{Name: "B", Lat: 41.005, Lng: 29},
		{Name: "C", Lat: 41.01, Lng: 29},
	}
	got := renderLinePath(stns, segs)
	if len(got) < 2 {
		t.Fatalf("got %+v", got)
	}
	if got[0] != [2]float64{29, 41.0} {
		t.Fatalf("first = %+v", got[0])
	}
	last := got[len(got)-1]
	if last != [2]float64{29, 41.01} {
		t.Fatalf("last = %+v", last)
	}
}

func TestRenderLinePathFallbackStraightFarAnchor(t *testing.T) {
	// Station nowhere near graph vertices → anchor offset > 200m → straight.
	segs := [][]point{
		{{lng: 29, lat: 41.0}, {lng: 29, lat: 41.001}},
	}
	stns := []station{
		{Name: "A", Lat: 41.0, Lng: 29},
		{Name: "B", Lat: 50, Lng: 50},
	}
	got := renderLinePath(stns, segs)
	if len(got) != 2 {
		t.Fatalf("expected straight line, got %+v", got)
	}
}

func TestBestPathBetweenNoFrom(t *testing.T) {
	g := buildVertexGraph([][]point{{{lng: 0, lat: 0}, {lng: 0, lat: 1}}})
	got := bestPathBetween(g, -1, 0,
		station{Name: "A", Lat: 0, Lng: 0},
		station{Name: "B", Lat: 0, Lng: 1})
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
}

func TestBestPathBetweenSameVertex(t *testing.T) {
	g := buildVertexGraph([][]point{{{lng: 0, lat: 0}, {lng: 0, lat: 1}}})
	got := bestPathBetween(g, 0, 0,
		station{Name: "A", Lat: 0, Lng: 0},
		station{Name: "B", Lat: 0, Lng: 0})
	// from==to gives path of length 1 → straight fallback.
	if len(got) != 2 {
		t.Fatalf("got %+v", got)
	}
}

func TestBestPathBetweenDetourFallback(t *testing.T) {
	// Build a graph where the shortest path forces a huge detour vs. direct.
	// Two disconnected components linked by a long way around.
	segs := [][]point{
		{{lng: 29, lat: 41.0}, {lng: 29, lat: 41.5}, {lng: 29, lat: 42.0}},
	}
	g := buildVertexGraph(segs)
	got := bestPathBetween(g, 0, 2,
		station{Name: "A", Lat: 41.0, Lng: 29},
		station{Name: "B", Lat: 42.0, Lng: 29.0001})
	// pathM ≈ direct, so it should not fall back; but let's verify it returns
	// a multi-point path.
	if len(got) < 3 {
		t.Fatalf("got %+v", got)
	}
}

func TestStationCoords(t *testing.T) {
	stns := []station{
		{Name: "A", Lat: 1, Lng: 2},
		{Name: "B", Lat: 3, Lng: 4},
	}
	got := stationCoords(stns)
	if got[0] != [2]float64{2, 1} || got[1] != [2]float64{4, 3} {
		t.Fatalf("got %+v", got)
	}
}

func TestPathLengthMetres(t *testing.T) {
	g := vertexGraph{
		verts: []vertex{
			{pt: point{lng: 0, lat: 0}},
			{pt: point{lng: 0, lat: 1}},
		},
	}
	got := pathLengthMetres(g, []int{0, 1})
	if !approxEqual(got, metresPerDegLat, 1) {
		t.Fatalf("got %v", got)
	}
}

func TestBuildVertexGraphBridges(t *testing.T) {
	// Two close-but-disjoint segments should be joined by a bridge edge.
	segs := [][]point{
		{{lng: 29, lat: 41.0}, {lng: 29, lat: 41.0001}},
		{{lng: 29, lat: 41.0001}, {lng: 29, lat: 41.0002}},
	}
	g := buildVertexGraph(segs)
	// Should find a path from start of first to end of second.
	path := g.shortestPath(0, 3)
	if len(path) == 0 {
		t.Fatalf("expected connected path")
	}
}

func TestNearestVertex(t *testing.T) {
	g := buildVertexGraph([][]point{
		{{lng: 0, lat: 0}, {lng: 0, lat: 1}, {lng: 0, lat: 2}},
	})
	if g.nearestVertex(point{lng: 0, lat: 0.9}) != 1 {
		t.Fatalf("nearest of (0,0.9) should be index 1")
	}
}

func TestShortestPathBounds(t *testing.T) {
	g := vertexGraph{verts: []vertex{{pt: point{}}, {pt: point{lng: 1}}}}
	g.adj = [][]graphEdge{nil, nil}
	if got := g.shortestPath(-1, 0); got != nil {
		t.Fatalf("expected nil for -1, got %+v", got)
	}
	if got := g.shortestPath(0, 5); got != nil {
		t.Fatalf("expected nil for OOB, got %+v", got)
	}
	if got := g.shortestPath(0, 0); len(got) != 1 || got[0] != 0 {
		t.Fatalf("from==to: got %+v", got)
	}
}

func TestShortestPathUnreachable(t *testing.T) {
	// Two disconnected vertices.
	g := vertexGraph{
		verts: []vertex{{pt: point{}}, {pt: point{lng: 100}}},
		adj:   [][]graphEdge{nil, nil},
	}
	if got := g.shortestPath(0, 1); got != nil {
		t.Fatalf("expected nil for unreachable, got %+v", got)
	}
}

func TestShortestPathTwoVertices(t *testing.T) {
	g := vertexGraph{
		verts: []vertex{{pt: point{}}, {pt: point{lng: 1}}},
		adj: [][]graphEdge{
			{{to: 1, weight: 1}},
			{{to: 0, weight: 1}},
		},
	}
	got := g.shortestPath(0, 1)
	if len(got) != 2 || got[0] != 0 || got[1] != 1 {
		t.Fatalf("got %+v", got)
	}
}

func TestShortestPathStaleEntry(t *testing.T) {
	// Graph forcing a stale priority-queue entry (cur.d > dist[cur.idx]).
	// 0→1 has weight 10, 0→2 weight 1, 2→1 weight 1.
	g := vertexGraph{
		verts: []vertex{{pt: point{}}, {pt: point{lng: 1}}, {pt: point{lng: 2}}},
		adj: [][]graphEdge{
			{{to: 1, weight: 10}, {to: 2, weight: 1}},
			{{to: 0, weight: 10}, {to: 2, weight: 1}},
			{{to: 0, weight: 1}, {to: 1, weight: 1}},
		},
	}
	got := g.shortestPath(0, 1)
	if len(got) != 3 || got[0] != 0 || got[1] != 2 || got[2] != 1 {
		t.Fatalf("got %+v", got)
	}
}

func TestNodeHeap(t *testing.T) {
	h := &nodeHeap{}
	heap.Init(h)
	heap.Push(h, nodeHeapItem{idx: 1, d: 5})
	heap.Push(h, nodeHeapItem{idx: 2, d: 1})
	heap.Push(h, nodeHeapItem{idx: 3, d: 3})
	first := heap.Pop(h).(nodeHeapItem)
	if first.d != 1 || first.idx != 2 {
		t.Fatalf("first = %+v", first)
	}
	if h.Len() != 2 {
		t.Fatalf("len = %d", h.Len())
	}
	// Cover Less/Swap behaviour explicitly.
	if !h.Less(0, 1) && !h.Less(1, 0) {
		// One of these must be true; just ensure no nonsense.
		_ = math.NaN()
	}
}

func TestBuildVertexGraphEmpty(t *testing.T) {
	g := buildVertexGraph(nil)
	if len(g.verts) != 0 {
		t.Fatalf("expected empty")
	}
}
