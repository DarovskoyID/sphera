package main

// Provisioned validator mode, separate from the loopback-only laboratory.
// Genesis, both private keys and last-sign state must already exist. This does
// not attest operator independence or authorize restoring an old signing state.
import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	cfg "github.com/cometbft/cometbft/config"
	cmtjson "github.com/cometbft/cometbft/libs/json"
	"github.com/cometbft/cometbft/p2p"
	"github.com/cometbft/cometbft/privval"
	"github.com/cometbft/cometbft/types"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

type ValidatorConfiguration struct {
	Domain          string   `json:"domain"`
	Home            string   `json:"home"`
	Network         string   `json:"network"`
	GenesisSHA256   string   `json:"genesis_sha256"`
	P2PListen       string   `json:"p2p_listen"`
	P2PExternal     string   `json:"p2p_external"`
	PersistentPeers []string `json:"persistent_peers"`
	RPCListen       string   `json:"rpc_listen"`
	MaxInbound      int      `json:"max_inbound"`
	MaxOutbound     int      `json:"max_outbound"`
}

var peerIDPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

func tcpAddress(value string, public bool) error {
	if !strings.HasPrefix(value, "tcp://") {
		return fmt.Errorf("explicit tcp address required")
	}
	host, portText, err := net.SplitHostPort(strings.TrimPrefix(value, "tcp://"))
	port, portErr := strconv.Atoi(portText)
	ip := net.ParseIP(host)
	if err != nil || portErr != nil || port < 1024 || port > 65535 || strconv.Itoa(port) != portText || ip == nil {
		return fmt.Errorf("literal IP and unprivileged port required")
	}
	if !ip.IsGlobalUnicast() && !ip.IsUnspecified() && !ip.IsLoopback() {
		return fmt.Errorf("unicast listener required")
	}
	if public && (!ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast()) {
		return fmt.Errorf("public peer IP required")
	}
	if public {
		for _, block := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32", "100::/64", "3fff::/20"} {
			_, network, _ := net.ParseCIDR(block)
			if network.Contains(ip) {
				return fmt.Errorf("globally routable peer IP required")
			}
		}
	}
	return nil
}

func provisionedFile(path string, private bool) ([]byte, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, fmt.Errorf("canonical absolute provisioned path required")
	}
	for parent := filepath.Clean(path); ; parent = filepath.Dir(parent) {
		info, err := os.Lstat(parent)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return nil, fmt.Errorf("provisioned path must not contain links")
		}
		if filepath.Dir(parent) == parent {
			break
		}
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4*1024*1024 {
		return nil, fmt.Errorf("bounded existing provisioned file required")
	}
	if private && runtime.GOOS == "linux" && info.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("private validator file permissions required")
	}
	return os.ReadFile(path)
}

func configuredValidator(path string) (*cfg.Config, string, error) {
	raw, err := provisionedFile(path, false)
	if err != nil {
		return nil, "", err
	}
	var v ValidatorConfiguration
	if json.Unmarshal(raw, &v) != nil || !bytes.Equal(bytes.TrimSpace(raw), canonical(v)) {
		return nil, "", fmt.Errorf("canonical complete validator configuration required")
	}
	if v.Domain != "sphere-validator-runtime-v1" || !filepath.IsAbs(v.Home) || filepath.Clean(v.Home) != v.Home || v.Network == "" || strings.HasPrefix(v.Network, "sfera-lab-") || len(v.Network) > 50 || !hex64.MatchString(v.GenesisSHA256) {
		return nil, "", fmt.Errorf("explicit non-laboratory context required")
	}
	if err = tcpAddress(v.P2PListen, false); err != nil {
		return nil, "", err
	}
	if err = tcpAddress(v.P2PExternal, true); err != nil {
		return nil, "", err
	}
	if err = tcpAddress(v.RPCListen, false); err != nil {
		return nil, "", err
	}
	rpcHost, _, _ := net.SplitHostPort(strings.TrimPrefix(v.RPCListen, "tcp://"))
	if rpcHost != "127.0.0.1" {
		return nil, "", fmt.Errorf("validator RPC must remain local")
	}
	if len(v.PersistentPeers) < 3 || len(v.PersistentPeers) > 127 || v.MaxInbound < 1 || v.MaxInbound > 128 || v.MaxOutbound < len(v.PersistentPeers) || v.MaxOutbound > 128 {
		return nil, "", fmt.Errorf("bounded explicit peer roster required")
	}
	peers := map[string]bool{}
	addresses := map[string]bool{}
	for _, peer := range v.PersistentPeers {
		parts := strings.Split(peer, "@")
		if len(parts) != 2 || !peerIDPattern.MatchString(parts[0]) || peers[parts[0]] || addresses[parts[1]] {
			return nil, "", fmt.Errorf("unique pinned peer identities and addresses required")
		}
		if err = tcpAddress("tcp://"+parts[1], true); err != nil {
			return nil, "", err
		}
		peers[parts[0]] = true
		addresses[parts[1]] = true
	}
	c := cfg.DefaultConfig().SetRoot(v.Home)
	genesisRaw, err := provisionedFile(c.GenesisFile(), false)
	if err != nil {
		return nil, "", err
	}
	digest := sha256.Sum256(genesisRaw)
	if hex.EncodeToString(digest[:]) != v.GenesisSHA256 {
		return nil, "", fmt.Errorf("independent genesis pin mismatch")
	}
	genesis, err := types.GenesisDocFromJSON(genesisRaw)
	if err != nil || genesis.ChainID != v.Network || len(genesis.Validators) < 4 || len(genesis.Validators) > 128 {
		return nil, "", fmt.Errorf("provisioned validator genesis required")
	}
	if _, err = genesisIssuers(genesis.AppState); err != nil {
		return nil, "", err
	}
	if _, err = genesisPolicyKeys(genesis); err != nil {
		return nil, "", err
	}
	keyRaw, err := provisionedFile(c.PrivValidatorKeyFile(), true)
	if err != nil {
		return nil, "", err
	}
	var key privval.FilePVKey
	if cmtjson.Unmarshal(keyRaw, &key) != nil || key.PubKey == nil || key.PrivKey == nil || key.PrivKey.Type() != "ed25519" || len(key.PrivKey.Bytes()) != 64 || len(key.PubKey.Bytes()) != 32 || !key.PrivKey.PubKey().Equals(key.PubKey) || !bytes.Equal(key.Address, key.PubKey.Address()) {
		return nil, "", fmt.Errorf("validator key mismatch")
	}
	admitted := false
	for _, validator := range genesis.Validators {
		if validator.PubKey.Equals(key.PubKey) && validator.Power > 0 {
			admitted = true
		}
	}
	if !admitted {
		return nil, "", fmt.Errorf("validator key absent from pinned genesis")
	}
	stateRaw, err := provisionedFile(c.PrivValidatorStateFile(), true)
	if err != nil {
		return nil, "", err
	}
	var last privval.FilePVLastSignState
	if cmtjson.Unmarshal(stateRaw, &last) != nil || last.Height < 0 || last.Round < 0 || last.Step < 0 || last.Step > 3 {
		return nil, "", fmt.Errorf("valid existing signing state required; never reset automatically")
	}
	if _, err = provisionedFile(c.NodeKeyFile(), true); err != nil {
		return nil, "", err
	}
	nodeKey, err := p2p.LoadNodeKey(c.NodeKeyFile())
	if err != nil {
		return nil, "", err
	}
	if nodeKey.PrivKey == nil || nodeKey.PrivKey.Type() != "ed25519" || len(nodeKey.PrivKey.Bytes()) != 64 {
		return nil, "", fmt.Errorf("provisioned node key required")
	}
	if peers[string(nodeKey.ID())] {
		return nil, "", fmt.Errorf("persistent peer roster includes own node")
	}
	c.P2P.ListenAddress = v.P2PListen
	c.P2P.ExternalAddress = strings.TrimPrefix(v.P2PExternal, "tcp://")
	c.P2P.PersistentPeers = strings.Join(v.PersistentPeers, ",")
	c.P2P.PexReactor = false
	c.P2P.AddrBookStrict = true
	c.P2P.AllowDuplicateIP = false
	c.P2P.MaxNumInboundPeers = v.MaxInbound
	c.P2P.MaxNumOutboundPeers = v.MaxOutbound
	c.RPC.ListenAddress = v.RPCListen
	c.RPC.Unsafe = false
	if err = c.ValidateBasic(); err != nil {
		return nil, "", err
	}
	return c, v.Network, nil
}
