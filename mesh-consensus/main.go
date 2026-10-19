package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
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
func initialize(root string) error {
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
func run(root string, index int) error {
	if index < 0 || index > 3 {
		return fmt.Errorf("validator index must be 0..3")
	}
	var lab Lab
	raw, e := os.ReadFile(filepath.Join(root, "lab.json"))
	if e != nil {
		return e
	}
	if e = json.Unmarshal(raw, &lab); e != nil {
		return e
	}
	if len(lab.Peers) != 4 || len(lab.RPC) != 4 {
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
	db, e := dbm.NewGoLevelDB("accounts", c.DBDir())
	if e != nil {
		return e
	}
	defer db.Close()
	app, e := NewApplication(db, lab.Chain)
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
	flag.Parse()
	var e error
	if *root == "" {
		e = fmt.Errorf("--home is required")
	} else if *init {
		e = initialize(*root)
	} else {
		e = run(*root, *index)
	}
	if e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
