package main

import (
	"container/heap"
	"math"
)

// renderLinePath collapses a line's raw MultiLineString segments into a single
// ordered visual polyline by routing through the polyline-vertex graph between
// consecutive ordered stations.
//
// Each raw segment vertex becomes a graph node; consecutive vertices inside a
// segment are connected by an edge of their inter-vertex distance, and any two
// vertices from different segments that sit within `bridgeTolMetres` of each
// other are joined too. Each station is anchored to its nearest vertex, and
// Dijkstra finds the shortest in-graph path between consecutive station
// anchors.
//
// Why this works on a network like M2: spurs and depot leads hang off the main
// line as dead ends, so Dijkstra never takes them. Parallel-track duplicates
// give the algorithm two routes between any two stations — it picks the
// shorter one, eliminating the criss-cross zigzag. When the graph can't find a
// reasonable path (no connection within tolerance, or the path balloons), we
// fall back to a straight line between the two station coordinates so the
// line stays visually continuous instead of breaking up.
func renderLinePath(stns []station, segs [][]point) [][2]float64 {
	if len(stns) < 2 {
		return stationCoords(stns)
	}
	g := buildVertexGraph(segs)
	if len(g.verts) == 0 {
		return stationCoords(stns)
	}

	anchors := make([]int, len(stns))
	for i, s := range stns {
		anchors[i] = g.nearestVertex(point{lng: s.Lng, lat: s.Lat})
	}

	out := make([][2]float64, 0, 64)
	pushSeg := func(seg [][2]float64) {
		if len(seg) == 0 {
			return
		}
		if len(out) == 0 {
			out = append(out, seg...)
			return
		}
		out = append(out, seg[1:]...)
	}

	for i := 0; i < len(stns)-1; i++ {
		a := stns[i]
		b := stns[i+1]
		seg := bestPathBetween(g, anchors[i], anchors[i+1], a, b)
		pushSeg(seg)
	}
	return out
}

// bestPathBetween returns the rendered segment from station a to station b: a
// Dijkstra path through the vertex graph if it's reasonable, or a straight
// line fallback otherwise. The returned coordinates always start at a and end
// at b so the concatenated polyline lands on every station marker.
func bestPathBetween(g vertexGraph, fromIdx, toIdx int, a, b station) [][2]float64 {
	pa := point{lng: a.Lng, lat: a.Lat}
	pb := point{lng: b.Lng, lat: b.Lat}
	straight := [][2]float64{{a.Lng, a.Lat}, {b.Lng, b.Lat}}
	directM := pa.distTo(pb)

	if fromIdx < 0 || toIdx < 0 {
		return straight
	}
	path := g.shortestPath(fromIdx, toIdx)
	if len(path) < 2 {
		return straight
	}
	pathM := pathLengthMetres(g, path)
	// Anchor offsets — distance from station to its anchor vertex. If the
	// nearest vertex is far from the station, the anchor itself is
	// untrustworthy and the straight line is the better choice.
	aOff := pa.distTo(g.verts[path[0]].pt)
	bOff := pb.distTo(g.verts[path[len(path)-1]].pt)
	if aOff > 200 || bOff > 200 {
		return straight
	}
	// Defensive bound: if Dijkstra had to detour to reach b, the path
	// blows up vs. the direct line. Tight ceiling here keeps the line clean
	// at the cost of using a straight segment in genuinely curvy stretches —
	// an acceptable trade for an overview map.
	if pathM > directM*1.8+150 {
		return straight
	}

	seg := make([][2]float64, 0, len(path)+2)
	seg = append(seg, [2]float64{a.Lng, a.Lat})
	for _, vi := range path {
		p := g.verts[vi].pt
		seg = append(seg, [2]float64{p.lng, p.lat})
	}
	seg = append(seg, [2]float64{b.Lng, b.Lat})
	return seg
}

func stationCoords(stns []station) [][2]float64 {
	out := make([][2]float64, len(stns))
	for i, s := range stns {
		out[i] = [2]float64{s.Lng, s.Lat}
	}
	return out
}

func pathLengthMetres(g vertexGraph, path []int) float64 {
	total := 0.0
	for i := 1; i < len(path); i++ {
		total += g.verts[path[i-1]].pt.distTo(g.verts[path[i]].pt)
	}
	return total
}

// --- vertex graph ------------------------------------------------------------

type vertex struct {
	pt point
}

type graphEdge struct {
	to     int
	weight float64
}

type vertexGraph struct {
	verts []vertex
	adj   [][]graphEdge
}

// bridgeTolMetres is the maximum gap that still gets joined by a graph edge
// between vertices from different raw segments. 25m matches the stitch()
// tolerance — anything farther is treated as a genuine break.
const bridgeTolMetres = 25.0

// bucketSizeDeg sizes the spatial grid used to find candidate bridge pairs.
// At Istanbul's latitude 0.0005° ≈ 50m, so the 3×3 window scanned during
// pair-finding fully covers the 25m bridge radius.
const bucketSizeDeg = 0.0005

func buildVertexGraph(segs [][]point) vertexGraph {
	totalPts := 0
	for _, s := range segs {
		totalPts += len(s)
	}
	g := vertexGraph{
		verts: make([]vertex, 0, totalPts),
		adj:   make([][]graphEdge, 0, totalPts),
	}
	segStart := make([]int, len(segs))
	for si, seg := range segs {
		segStart[si] = len(g.verts)
		for _, p := range seg {
			g.verts = append(g.verts, vertex{pt: p})
			g.adj = append(g.adj, nil)
		}
	}
	// Intra-segment edges.
	for si, seg := range segs {
		base := segStart[si]
		for i := 1; i < len(seg); i++ {
			d := seg[i-1].distTo(seg[i])
			a := base + i - 1
			b := base + i
			g.adj[a] = append(g.adj[a], graphEdge{to: b, weight: d})
			g.adj[b] = append(g.adj[b], graphEdge{to: a, weight: d})
		}
	}
	addBridgeEdges(&g)
	return g
}

type cellKey struct{ x, y int }

func addBridgeEdges(g *vertexGraph) {
	buckets := map[cellKey][]int{}
	for i, v := range g.verts {
		k := cellKey{
			x: int(math.Floor(v.pt.lng / bucketSizeDeg)),
			y: int(math.Floor(v.pt.lat / bucketSizeDeg)),
		}
		buckets[k] = append(buckets[k], i)
	}
	// Track joined pairs to avoid duplicate edges.
	type pair struct{ a, b int }
	seen := map[pair]bool{}
	for i, v := range g.verts {
		bx := int(math.Floor(v.pt.lng / bucketSizeDeg))
		by := int(math.Floor(v.pt.lat / bucketSizeDeg))
		for dx := -1; dx <= 1; dx++ {
			for dy := -1; dy <= 1; dy++ {
				for _, j := range buckets[cellKey{x: bx + dx, y: by + dy}] {
					if j <= i {
						continue
					}
					d := v.pt.distTo(g.verts[j].pt)
					if d > bridgeTolMetres {
						continue
					}
					p := pair{a: i, b: j}
					if seen[p] {
						continue
					}
					seen[p] = true
					g.adj[i] = append(g.adj[i], graphEdge{to: j, weight: d})
					g.adj[j] = append(g.adj[j], graphEdge{to: i, weight: d})
				}
			}
		}
	}
}

func (g vertexGraph) nearestVertex(p point) int {
	best := -1
	bestD := math.Inf(1)
	for i, v := range g.verts {
		d := v.pt.distTo(p)
		if d < bestD {
			bestD = d
			best = i
		}
	}
	return best
}

// --- Dijkstra ----------------------------------------------------------------

func (g vertexGraph) shortestPath(from, to int) []int {
	n := len(g.verts)
	if from < 0 || from >= n || to < 0 || to >= n {
		return nil
	}
	if from == to {
		return []int{from}
	}
	dist := make([]float64, n)
	prev := make([]int, n)
	for i := range dist {
		dist[i] = math.Inf(1)
		prev[i] = -1
	}
	dist[from] = 0

	pq := &nodeHeap{{idx: from, d: 0}}
	heap.Init(pq)
	for pq.Len() > 0 {
		cur := heap.Pop(pq).(nodeHeapItem)
		if cur.d > dist[cur.idx] {
			continue
		}
		if cur.idx == to {
			break
		}
		for _, e := range g.adj[cur.idx] {
			nd := cur.d + e.weight
			if nd < dist[e.to] {
				dist[e.to] = nd
				prev[e.to] = cur.idx
				heap.Push(pq, nodeHeapItem{idx: e.to, d: nd})
			}
		}
	}
	if math.IsInf(dist[to], 1) {
		return nil
	}
	// Reconstruct.
	path := []int{}
	for at := to; at != -1; at = prev[at] {
		path = append(path, at)
	}
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path
}

type nodeHeapItem struct {
	idx int
	d   float64
}

type nodeHeap []nodeHeapItem

func (h nodeHeap) Len() int            { return len(h) }
func (h nodeHeap) Less(i, j int) bool  { return h[i].d < h[j].d }
func (h nodeHeap) Swap(i, j int)       { h[i], h[j] = h[j], h[i] }
func (h *nodeHeap) Push(x any)         { *h = append(*h, x.(nodeHeapItem)) }
func (h *nodeHeap) Pop() any {
	old := *h
	n := len(old)
	x := old[n-1]
	*h = old[:n-1]
	return x
}
