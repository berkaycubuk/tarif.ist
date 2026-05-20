package main

import (
	"math"
	"testing"
)

func approxEqual(a, b, eps float64) bool {
	return math.Abs(a-b) <= eps
}

func TestPointDistTo(t *testing.T) {
	// Distance from a point to itself is zero.
	p := point{lng: 28.97, lat: 41.0}
	if d := p.distTo(p); d != 0 {
		t.Fatalf("distTo self = %v, want 0", d)
	}

	// 1 degree of latitude ≈ 111320 metres.
	q := point{lng: 28.97, lat: 42.0}
	if d := p.distTo(q); !approxEqual(d, metresPerDegLat, 1) {
		t.Fatalf("distTo +1lat = %v, want ~%v", d, metresPerDegLat)
	}

	// 1 degree of longitude at Istanbul latitude ≈ metresPerDegLng.
	r := point{lng: 29.97, lat: 41.0}
	if d := p.distTo(r); !approxEqual(d, metresPerDegLng, 1) {
		t.Fatalf("distTo +1lng = %v, want ~%v", d, metresPerDegLng)
	}
}

func TestProjectOnSegmentMiddle(t *testing.T) {
	a := point{lng: 0, lat: 0}
	b := point{lng: 1, lat: 0}
	p := point{lng: 0.5, lat: 0.5}
	proj, tt, d2 := projectOnSegment(p, a, b)
	if !approxEqual(tt, 0.5, 1e-9) {
		t.Fatalf("t = %v, want 0.5", tt)
	}
	if !approxEqual(proj.lng, 0.5, 1e-9) || proj.lat != 0 {
		t.Fatalf("proj = %+v, want lng=0.5 lat=0", proj)
	}
	want := 0.5 * metresPerDegLat
	if !approxEqual(math.Sqrt(d2), want, 1) {
		t.Fatalf("d2 = %v (sqrt %v), want sqrt ~%v", d2, math.Sqrt(d2), want)
	}
}

func TestProjectOnSegmentClampLow(t *testing.T) {
	a := point{lng: 0, lat: 0}
	b := point{lng: 1, lat: 0}
	p := point{lng: -1, lat: 0}
	proj, tt, _ := projectOnSegment(p, a, b)
	if tt != 0 {
		t.Fatalf("t = %v, want 0 (clamped)", tt)
	}
	if proj.lng != 0 || proj.lat != 0 {
		t.Fatalf("proj = %+v, want a", proj)
	}
}

func TestProjectOnSegmentClampHigh(t *testing.T) {
	a := point{lng: 0, lat: 0}
	b := point{lng: 1, lat: 0}
	p := point{lng: 2, lat: 0}
	proj, tt, _ := projectOnSegment(p, a, b)
	if tt != 1 {
		t.Fatalf("t = %v, want 1 (clamped)", tt)
	}
	if proj.lng != 1 || proj.lat != 0 {
		t.Fatalf("proj = %+v, want b", proj)
	}
}

func TestProjectOnSegmentZeroLength(t *testing.T) {
	a := point{lng: 1, lat: 1}
	b := point{lng: 1, lat: 1}
	p := point{lng: 2, lat: 1}
	proj, tt, d2 := projectOnSegment(p, a, b)
	if tt != 0 {
		t.Fatalf("t = %v, want 0", tt)
	}
	if proj != a {
		t.Fatalf("proj = %+v, want a", proj)
	}
	if d2 == 0 {
		t.Fatalf("d2 = 0, want >0")
	}
}
