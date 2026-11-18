package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	dbm "github.com/cometbft/cometbft-db"
	cfg "github.com/cometbft/cometbft/config"
	"github.com/cometbft/cometbft/libs/log"
	"github.com/cometbft/cometbft/node"
	"github.com/cometbft/cometbft/p2p"
	"github.com/cometbft/cometbft/privval"
	"github.com/cometbft/cometbft/proxy"
	"github.com/cometbft/cometbft/types"
)

// Only loopback addresses, fixed four-validator genesis, no public admission.
type Lab struct {
	Chain string   `json:"chain"`
	Peers []string `json:"peers"`
	RPC   []string `json:"rpc"`
}

func freeAddress() (string, error) {
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		return "", e
	}
	defer l.Close()
	return l.Addr().String(), nil
}
func initialize(root string, issuerPath string, policy bool, compact ...bool) error {
	var issuerConfig []byte
	if issuerPath != "" {
		raw, e := os.ReadFile(issuerPath)
		if e != nil {
			return e
		}
		var issuers map[string]string
		if e = json.Unmarshal(raw, &issuers); e != nil {
			return e
		}
		if e = validateIssuers(issuers); e != nil {
			return e
		}
		if len(issuers) == 0 {
			return fmt.Errorf("explicit issuer file must not be empty")
		}
		issuerConfig = canonical(GenesisApplication{Issuers: issuers, PlacementPolicy: policy})
	}
	if policy && issuerPath == "" {
		return fmt.Errorf("placement policy requires pinned license issuers")
	}
	if len(compact) > 0 && compact[0] || len(compact) > 1 && compact[1] {
		var config GenesisApplication
		if len(issuerConfig) > 0 {
			if err := json.Unmarshal(issuerConfig, &config); err != nil {
				return err
			}
		}
		if compact[0] {
			config.StateCommitment = stateMerkleScheme
		}
		if len(compact) > 1 && compact[1] {
			config.EndpointPolicy = "https-v1"
		}
		issuerConfig = canonical(config)
	}
	if _, e := os.Stat(root); !os.IsNotExist(e) {
		return fmt.Errorf("lab directory must not exist")
	}
	if e := os.Mkdir(root, 0700); e != nil {
		return e
	}
	lab := Lab{Chain: fmt.Sprintf("sfera-lab-%d", time.Now().UnixNano())}
	validators := []types.GenesisValidator{}
	for i := 0; i < 4; i++ {
		home := filepath.Join(root, fmt.Sprint(i))
		c := cfg.DefaultConfig().SetRoot(home)
		cfg.EnsureRoot(home)
		pv := privval.LoadOrGenFilePV(c.PrivValidatorKeyFile(), c.PrivValidatorStateFile())
		pub, e := pv.GetPubKey()
		if e != nil {
			return e
		}
		validators = append(validators, types.GenesisValidator{Address: pub.Address(), PubKey: pub, Power: 1})
		key, e := p2p.LoadOrGenNodeKey(c.NodeKeyFile())
		if e != nil {
			return e
		}
		addr, e := freeAddress()
		if e != nil {
			return e
		}
		lab.Peers = append(lab.Peers, string(key.ID())+"@"+addr)
		addr, e = freeAddress()
		if e != nil {
			return e
		}
		lab.RPC = append(lab.RPC, "tcp://"+addr)
	}
	genesis := &types.GenesisDoc{GenesisTime: time.Now().UTC(), ChainID: lab.Chain, ConsensusParams: types.DefaultConsensusParams(), Validators: validators}
	genesis.AppState = issuerConfig
	for i := 0; i < 4; i++ {
		if e := genesis.SaveAs(filepath.Join(root, fmt.Sprint(i), "config", "genesis.json")); e != nil {
			return e
		}
	}
	raw, e := json.Marshal(lab)
	if e != nil {
		return e
	}
	return os.WriteFile(filepath.Join(root, "lab.json"), raw, 0600)
}
func addStandby(root string) error {
	var lab Lab
	raw, err := os.ReadFile(filepath.Join(root, "lab.json"))
	if err != nil {
		return err
	}
	if err = json.Unmarshal(raw, &lab); err != nil {
		return err
	}
	if len(lab.Peers) != 4 || len(lab.RPC) != 4 {
		return fmt.Errorf("standby requires new four-node lab")
	}
	home := filepath.Join(root, "4")
	c := cfg.DefaultConfig().SetRoot(home)
	cfg.EnsureRoot(home)
	privval.LoadOrGenFilePV(c.PrivValidatorKeyFile(), c.PrivValidatorStateFile())
	key, err := p2p.LoadOrGenNodeKey(c.NodeKeyFile())
	if err != nil {
		return err
	}
	addr, err := freeAddress()
	if err != nil {
		return err
	}
	lab.Peers = append(lab.Peers, string(key.ID())+"@"+addr)
	addr, err = freeAddress()
	if err != nil {
		return err
	}
	lab.RPC = append(lab.RPC, "tcp://"+addr)
	genesis, err := os.ReadFile(filepath.Join(root, "0", "config", "genesis.json"))
	if err != nil {
		return err
	}
	if err = os.WriteFile(c.GenesisFile(), genesis, 0600); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, "lab.json"), canonical(lab), 0600)
}
func run(root string, index int) error {
	var lab Lab
	raw, e := os.ReadFile(filepath.Join(root, "lab.json"))
	if e != nil {
		return e
	}
	if e = json.Unmarshal(raw, &lab); e != nil {
		return e
	}
	if len(lab.Peers) < 4 || len(lab.Peers) > 5 || len(lab.RPC) != len(lab.Peers) || index < 0 || index >= len(lab.Peers) {
		return fmt.Errorf("invalid lab roster")
	}
	for i := range lab.Peers {
		parts := strings.Split(lab.Peers[i], "@")
		if len(parts) != 2 {
			return fmt.Errorf("invalid peer")
		}
		host, _, e := net.SplitHostPort(parts[1])
		if e != nil || host != "127.0.0.1" || !strings.HasPrefix(lab.RPC[i], "tcp://127.0.0.1:") {
			return fmt.Errorf("loopback only")
		}
	}
	c := cfg.DefaultConfig().SetRoot(filepath.Join(root, fmt.Sprint(index)))
	c.P2P.ListenAddress = "tcp://" + strings.Split(lab.Peers[index], "@")[1]
	c.RPC.ListenAddress = lab.RPC[index]
	peers := []string{}
	for i, p := range lab.Peers {
		if i != index {
			peers = append(peers, p)
		}
	}
	c.P2P.PersistentPeers = strings.Join(peers, ",")
	c.P2P.AddrBookStrict = false
	c.P2P.AllowDuplicateIP = true
	c.P2P.PexReactor = false
	c.Consensus.TimeoutCommit = 300 * time.Millisecond
	c.Consensus.TimeoutPropose = time.Second
	return serveValidator(c, lab.Chain)
}
func serveValidator(c *cfg.Config, chain string) error {
	db, e := dbm.NewGoLevelDB("accounts", c.DBDir())
	if e != nil {
		return e
	}
	defer db.Close()
	genesis, e := types.GenesisDocFromFile(c.GenesisFile())
	if e != nil {
		return e
	}
	issuers, e := genesisIssuers(genesis.AppState)
	if e != nil {
		return e
	}
	policyKeys, e := genesisPolicyKeys(genesis)
	if e != nil {
		return e
	}
	genesisRaw, e := os.ReadFile(c.GenesisFile())
	if e != nil {
		return e
	}
	genesisDigest := sha256.Sum256(genesisRaw)
	var appConfig GenesisApplication
	if len(genesis.AppState) > 0 {
		if e := json.Unmarshal(genesis.AppState, &appConfig); e != nil {
			return e
		}
	}
	app, e := NewApplicationWithPolicy(db, chain, issuers, policyKeys, hex.EncodeToString(genesisDigest[:]), appConfig.StateCommitment, appConfig.EndpointPolicy)
	if e != nil {
		return e
	}
	key, e := p2p.LoadNodeKey(c.NodeKeyFile())
	if e != nil {
		return e
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	n, e := node.NewNodeWithContext(ctx, c, privval.LoadFilePV(c.PrivValidatorKeyFile(), c.PrivValidatorStateFile()), key, proxy.NewLocalClientCreator(app), node.DefaultGenesisDocProviderFunc(c), cfg.DefaultDBProvider, node.DefaultMetricsProvider(c.Instrumentation), log.NewNopLogger())
	if e != nil {
		return e
	}
	if e = n.Start(); e != nil {
		return e
	}
	<-ctx.Done()
	if n.IsRunning() {
		if e = n.Stop(); e != nil {
			return e
		}
	}
	n.Wait()
	return nil
}
func main() {
	root := flag.String("home", "", "new lab directory / existing validator home parent")
	index := flag.Int("validator", -1, "validator 0..3")
	init := flag.Bool("init", false, "initialize four-node lab exclusively")
	verify := flag.String("verify-genesis", "", "verify stdin evidence against a locally pinned genesis")
	verifyProof := flag.String("verify-state-proof-genesis", "", "verify compact state proof against a locally pinned genesis")
	compactProofs := flag.Bool("compact-proofs", false, "use Merkle app hash for a NEW laboratory genesis")
	standby := flag.Bool("standby", false, "initialize an additional non-voting node for committee transition tests")
	issuers := flag.String("license-issuers", "", "public issuer map for a NEW laboratory genesis")
	policy := flag.Bool("placement-policy", false, "require quorum resource assessments and optimal replacement in a NEW lab")
	nodeConfig := flag.String("node-config", "", "explicit provisioned Linux validator configuration; never generates keys/genesis")
	checkNode := flag.Bool("check-node-config", false, "validate --node-config without starting listeners or databases")
	httpsEndpoints := flag.Bool("https-endpoints", false, "pin HTTPS endpoint discovery policy in a NEW genesis only")
	flag.Parse()
	var e error
	if *nodeConfig != "" {
		if *root != "" || *index != -1 || *init || *verify != "" || *verifyProof != "" || *issuers != "" || *policy || *compactProofs || *standby || *httpsEndpoints {
			e = fmt.Errorf("node-config cannot be combined with lab or proof flags")
		} else {
			var configured *cfg.Config
			var chain string
			configured, chain, e = configuredValidator(*nodeConfig)
			if e == nil && !*checkNode {
				if runtime.GOOS != "linux" {
					e = fmt.Errorf("provisioned validator runtime requires Linux")
				} else {
					e = serveValidator(configured, chain)
				}
			}
		}
	} else if *checkNode {
		e = fmt.Errorf("check-node-config requires node-config")
	} else if (*issuers != "" || *policy || *compactProofs || *standby || *httpsEndpoints) && !*init {
		e = fmt.Errorf("license issuer configuration is only accepted with --init")
	} else if *verifyProof != "" {
		e = verifyProofInput(*verifyProof)
	} else if *verify != "" {
		e = verifyInput(*verify)
	} else if *root == "" {
		e = fmt.Errorf("--home is required")
	} else if *init {
		e = initialize(*root, *issuers, *policy, *compactProofs, *httpsEndpoints)
		if e == nil && *standby {
			e = addStandby(*root)
		}
	} else {
		e = run(*root, *index)
	}
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
