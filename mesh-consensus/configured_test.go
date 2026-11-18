package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	cfg "github.com/cometbft/cometbft/config"
	"github.com/cometbft/cometbft/crypto/ed25519"
	cmtjson "github.com/cometbft/cometbft/libs/json"
	"github.com/cometbft/cometbft/privval"
	"github.com/cometbft/cometbft/types"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func configuredFixture(t *testing.T) (ValidatorConfiguration, string) {
	t.Helper()
	root := filepath.Join(t.TempDir(), "lab")
	if err := initialize(root, "", false); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(root, "0")
	c := cfg.DefaultConfig().SetRoot(home)
	genesis, err := types.GenesisDocFromFile(c.GenesisFile())
	if err != nil {
		t.Fatal(err)
	}
	genesis.ChainID = "configured-validator-test"
	if err = genesis.SaveAs(c.GenesisFile()); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(c.GenesisFile())
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	return ValidatorConfiguration{Domain: "sphere-validator-runtime-v1", Home: home, Network: genesis.ChainID, GenesisSHA256: hex.EncodeToString(digest[:]),
		P2PListen: "tcp://0.0.0.0:26656", P2PExternal: "tcp://8.8.8.8:26656", PersistentPeers: []string{
			strings.Repeat("1", 40) + "@1.1.1.1:26656", strings.Repeat("2", 40) + "@8.8.4.4:26656", strings.Repeat("3", 40) + "@9.9.9.9:26656"},
		RPCListen: "tcp://127.0.0.1:26657", MaxInbound: 16, MaxOutbound: 8}, filepath.Join(root, "operator.json")
}

func writeConfiguration(t *testing.T, path string, v ValidatorConfiguration) {
	t.Helper()
	if err := os.WriteFile(path, canonical(v), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestConfiguredValidatorReadOnlyAndHardened(t *testing.T) {
	v, path := configuredFixture(t)
	writeConfiguration(t, path, v)
	c := cfg.DefaultConfig().SetRoot(v.Home)
	before, _ := os.ReadFile(c.PrivValidatorStateFile())
	configured, chain, err := configuredValidator(path)
	if err != nil {
		t.Fatal(err)
	}
	if chain != v.Network || configured.P2P.PexReactor || configured.P2P.AllowDuplicateIP || !configured.P2P.AddrBookStrict || configured.RPC.Unsafe || configured.RPC.ListenAddress != v.RPCListen {
		t.Fatal("unsafe public defaults")
	}
	after, _ := os.ReadFile(c.PrivValidatorStateFile())
	if !bytes.Equal(before, after) {
		t.Fatal("signing state changed during validation")
	}
	if _, err = os.Stat(filepath.Join(c.DBDir(), "accounts.db")); !os.IsNotExist(err) {
		t.Fatal("validation opened an application database")
	}
}

func TestConfiguredValidatorRejectsUnsafeAddressesAndPins(t *testing.T) {
	original, path := configuredFixture(t)
	cases := []func(*ValidatorConfiguration){
		func(v *ValidatorConfiguration) { v.RPCListen = "tcp://0.0.0.0:26657" },
		func(v *ValidatorConfiguration) { v.P2PExternal = "tcp://127.0.0.1:26656" },
		func(v *ValidatorConfiguration) { v.P2PExternal = "tcp://198.51.100.1:26656" },
		func(v *ValidatorConfiguration) { v.P2PExternal = "tcp://point.example:26656" },
		func(v *ValidatorConfiguration) { v.GenesisSHA256 = strings.Repeat("0", 64) },
		func(v *ValidatorConfiguration) { v.Network = "sfera-lab-not-production" },
		func(v *ValidatorConfiguration) {
			v.PersistentPeers = []string{original.PersistentPeers[0], original.PersistentPeers[0], original.PersistentPeers[2]}
		},
		func(v *ValidatorConfiguration) { v.MaxOutbound = 2 },
	}
	for index, change := range cases {
		v := original
		change(&v)
		writeConfiguration(t, path, v)
		if _, _, err := configuredValidator(path); err == nil {
			t.Fatalf("unsafe case %d accepted", index)
		}
	}
	writeConfiguration(t, path, original)
	raw := append([]byte(`{"unknown":true,`), canonical(original)[1:]...)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := configuredValidator(path); err == nil {
		t.Fatal("unknown config accepted")
	}
}

func TestConfiguredValidatorNeverCreatesMissingSigningState(t *testing.T) {
	v, path := configuredFixture(t)
	writeConfiguration(t, path, v)
	c := cfg.DefaultConfig().SetRoot(v.Home)
	before, _ := os.ReadFile(c.PrivValidatorKeyFile())
	if err := os.Remove(c.PrivValidatorStateFile()); err != nil {
		t.Fatal(err)
	}
	if _, _, err := configuredValidator(path); err == nil {
		t.Fatal("missing anti-double-sign state accepted")
	}
	after, _ := os.ReadFile(c.PrivValidatorKeyFile())
	if !bytes.Equal(before, after) {
		t.Fatal("validator key replaced")
	}
	if _, err := os.Stat(c.PrivValidatorStateFile()); !os.IsNotExist(err) {
		t.Fatal("signing state regenerated")
	}
}

func TestConfiguredValidatorRejectsUnadmittedKey(t *testing.T) {
	v, path := configuredFixture(t)
	writeConfiguration(t, path, v)
	c := cfg.DefaultConfig().SetRoot(v.Home)
	private := ed25519.GenPrivKey()
	key := privval.FilePVKey{Address: private.PubKey().Address(), PubKey: private.PubKey(), PrivKey: private}
	raw, err := cmtjson.Marshal(key)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(c.PrivValidatorKeyFile(), raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err = configuredValidator(path); err == nil {
		t.Fatal("self-generated validator acquired authority")
	}
}
