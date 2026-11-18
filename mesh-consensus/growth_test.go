package main

import (
	"crypto/ed25519"
	"encoding/hex"
	"sort"
	"testing"
)

func TestGrowthRequiresThreePreparedHoldersAndImmutableIntent(t *testing.T) {
	s, keys, cluster := manifestState(t)
	p := s.Placements[cluster]
	b := GrowthBody{Domain: "sfera-mesh-growth-v1", Network: "lab", Cluster: cluster, Epoch: 1, PlacementHash: p.Digest, Origin: p.Record.Body.Members[0], Token: zero, Amount: 1024, IssuedAt: 1000, PrepareExpiresAt: 1060}
	b.BudgetID = growthID(b)
	sign := func(body GrowthBody) GrowthRecord {
		r := GrowthRecord{Body: body, Consents: []Consent{}}
		for _, key := range keys[:3] {
			r.Consents = append(r.Consents, Consent{hex.EncodeToString(key.Public().(ed25519.PublicKey)), hex.EncodeToString(ed25519.Sign(key, canonical(body)))})
		}
		sort.Slice(r.Consents, func(i, j int) bool { return r.Consents[i].PublicKey < r.Consents[j].PublicKey })
		return r
	}
	r := sign(b)
	bad := r
	bad.Consents = r.Consents[:2]
	if apply(&s, canonical(bad)) == nil || len(s.GrowthGrants) != 0 {
		t.Fatal("partial reservation confirmed")
	}
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal(err)
	}
	b.Amount = 2048
	if apply(&s, canonical(sign(b))) == nil {
		t.Fatal("same intent changed its amount")
	}
	s.BlockTime = 1100
	if err := apply(&s, canonical(r)); err != nil {
		t.Fatal("expired exact retry changed history", err)
	}
	if err := verifyGrowthGrants(s); err != nil {
		t.Fatal("historical grant lost after preparation deadline", err)
	}
	b.Token = s.Placements[cluster].Digest
	b.BudgetID = growthID(b)
	if apply(&s, canonical(sign(b))) == nil {
		t.Fatal("late prepare confirmed")
	}
}
