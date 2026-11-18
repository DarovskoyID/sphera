package main

import "testing"

func TestPlacementModuleScore(t *testing.T) {
	for _, test := range []struct {
		name             string
		modules          [3][]string
		spread, mismatch int
	}{
		{"free core", [3][]string{{}, {}, {}}, 0, 0},
		{"equal sets", [3][]string{{"office", "planner"}, {"planner", "office"}, {"office", "planner"}}, 0, 0},
		{"equal counts different sets", [3][]string{{"office"}, {"planner"}, {"conference"}}, 0, 6},
		{"unequal counts", [3][]string{{}, {"office"}, {"office", "planner"}}, 2, 4},
	} {
		t.Run(test.name, func(t *testing.T) {
			documents := make([]LicenseDocument, 3)
			for i, ids := range test.modules {
				for _, id := range ids {
					documents[i].Claims.Modules = append(documents[i].Claims.Modules, LicenseModule{ID: id})
				}
			}
			spread, mismatch, err := placementModuleScore(documents)
			if err != nil || spread != test.spread || mismatch != test.mismatch {
				t.Fatalf("got %d/%d, %v", spread, mismatch, err)
			}
		})
	}
}

func TestRankingRejectsUnverifiedPlacement(t *testing.T) {
	p, _, err := decodePlacement(signedPlacement(placementKeys(t, 3), 1, zero, ""), "lab")
	if err != nil {
		t.Fatal(err)
	}
	spread, mismatch, err := rankLicensedPlacement(p, testIssuers(), 1000)
	if err != nil || spread != 0 || mismatch != 0 {
		t.Fatal("valid profile ranking failed", err)
	}
	if _, _, err := rankLicensedPlacement(p, testIssuers(), 1300); err == nil {
		t.Fatal("expired profiles ranked")
	}
	if _, _, err := rankLicensedPlacement(p, nil, 1000); err == nil {
		t.Fatal("unknown issuer ranked")
	}
	p.Licenses[0].Claims.Modules = []LicenseModule{}
	if _, _, err := rankLicensedPlacement(p, testIssuers(), 1000); err == nil {
		t.Fatal("tampered profiles ranked")
	}
}
