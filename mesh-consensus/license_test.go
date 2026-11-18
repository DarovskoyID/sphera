package main

import (
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"testing"
	"time"

	dbm "github.com/cometbft/cometbft-db"
	abci "github.com/cometbft/cometbft/abci/types"
)

func TestFinalizationUsesBlockTimeAfterMempoolAcceptance(t *testing.T) {
	db := dbm.NewMemDB()
	defer db.Close()
	a, err := NewApplicationWithIssuers(db, "lab", testIssuers())
	if err != nil {
		t.Fatal(err)
	}
	a.state.BlockTime = 1000
	tx := signedPlacement(placementKeys(t, 3), 1, zero, "")
	ctx := context.Background()
	checked, err := a.CheckTx(ctx, &abci.RequestCheckTx{Tx: tx})
	if err != nil || checked.Code != 0 {
		t.Fatal("valid profile not admitted", err)
	}
	finalized, err := a.FinalizeBlock(ctx, &abci.RequestFinalizeBlock{Height: 1, Time: time.Unix(1300, 0), Txs: [][]byte{tx}})
	if err != nil || finalized.TxResults[0].Code == 0 || len(a.pending.Placements) != 0 {
		t.Fatal("expired profile activated at finalization", err)
	}
}

func TestCommercialProfileValidationAndZeroPaidModules(t *testing.T) {
	keys := placementKeys(t, 3)
	record, _, err := decodePlacement(signedPlacement(keys, 1, zero, ""), "lab")
	if err != nil {
		t.Fatal(err)
	}
	document := record.Licenses[0]
	node := record.Body.Members[0]
	if err = verifyLicense(document, testIssuers(), node, "lab", 1000); err != nil {
		t.Fatal(err)
	}
	for _, at := range []int64{0, 900, 1290, 5000} {
		if err = verifyLicense(document, testIssuers(), node, "lab", at); err == nil {
			t.Fatalf("invalid consensus time accepted: %d", at)
		}
	}
	document.Claims.Modules = []LicenseModule{}
	document.Signature = hex.EncodeToString(ed25519.Sign(testIssuer, canonical(document.Claims)))
	if err = verifyLicense(document, testIssuers(), node, "lab", 1000); err != nil {
		t.Fatal("free core placement profile rejected", err)
	}
	document.Claims.Modules = nil
	document.Signature = hex.EncodeToString(ed25519.Sign(testIssuer, canonical(document.Claims)))
	if err = verifyLicense(document, testIssuers(), node, "lab", 1000); err == nil {
		t.Fatal("null modules accepted")
	}
}
func TestHistoricalProfileExpiryDoesNotEraseAcceptedPlacement(t *testing.T) {
	keys := placementKeys(t, 3)
	state := State{Network: "lab", Accounts: map[string]Head{}, Issuers: testIssuers(), BlockTime: 1000}
	tx := signedPlacement(keys, 1, zero, "")
	if err := apply(&state, tx); err != nil {
		t.Fatal(err)
	}
	state.BlockTime = 5000
	if err := verifyPlacementHistory(state); err != nil {
		t.Fatal("historical license rechecked at present time", err)
	}
	if err := apply(&state, tx); err != nil {
		t.Fatal("idempotent old record incorrectly treated as a new grant", err)
	}
}
func TestIssuerConfigurationPinnedAcrossApplicationRestart(t *testing.T) {
	db := dbm.NewMemDB()
	defer db.Close()
	a, err := NewApplicationWithIssuers(db, "lab", testIssuers())
	if err != nil {
		t.Fatal(err)
	}
	if err = db.SetSync([]byte("state"), canonical(a.state)); err != nil {
		t.Fatal(err)
	}
	if _, err = NewApplication(db, "lab"); err == nil {
		t.Fatal("issuer removed silently")
	}
	if _, err = NewApplicationWithIssuers(db, "lab", testIssuers()); err != nil {
		t.Fatal(err)
	}
}
