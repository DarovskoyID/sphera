package main

import "errors"

// placementModuleScore matches topology.py: count spread first, then the
// sum of pairwise symmetric differences. Inputs must be verified profiles.
func placementModuleScore(documents []LicenseDocument) (int, int, error) {
	if len(documents) != 3 {
		return 0, 0, errors.New("three placement profiles required")
	}
	sets := make([]map[string]bool, 3)
	minimum, maximum := 16, 0
	for i, document := range documents {
		sets[i] = map[string]bool{}
		for _, module := range document.Claims.Modules {
			if !paidModules[module.ID] || sets[i][module.ID] {
				return 0, 0, errors.New("invalid placement modules")
			}
			sets[i][module.ID] = true
		}
		count := len(sets[i])
		if count < minimum {
			minimum = count
		}
		if count > maximum {
			maximum = count
		}
	}
	mismatch := 0
	for i := 0; i < 3; i++ {
		for j := i + 1; j < 3; j++ {
			for id := range sets[i] {
				if !sets[j][id] {
					mismatch++
				}
			}
			for id := range sets[j] {
				if !sets[i][id] {
					mismatch++
				}
			}
		}
	}
	return maximum - minimum, mismatch, nil
}

// rankLicensedPlacement verifies signatures and time before computing a score.
// It does not establish resource eligibility or prove that alternatives were
// exhaustively enumerated; those require a consensus-backed candidate registry.
func rankLicensedPlacement(p Placement, issuers map[string]string, at int64) (int, int, error) {
	if _, _, err := decodePlacement(canonical(p), p.Body.Network); err != nil {
		return 0, 0, err
	}
	if err := verifyPlacementLicenses(p, issuers, at); err != nil {
		return 0, 0, err
	}
	return placementModuleScore(p.Licenses)
}
