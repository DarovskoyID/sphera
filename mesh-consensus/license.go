package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"regexp"
)

type LicenseModule struct {
	ID        string `json:"id"`
	ExpiresAt int64  `json:"expires_at"`
}
type LicenseClaims struct {
	Schema     string          `json:"schema"`
	Issuer     string          `json:"issuer"`
	InstanceID string          `json:"instance_id"`
	NodeID     string          `json:"node_id"`
	Network    string          `json:"network"`
	IssuedAt   int64           `json:"issued_at"`
	ExpiresAt  int64           `json:"expires_at"`
	Modules    []LicenseModule `json:"modules"`
}
type LicenseDocument struct {
	Claims    LicenseClaims `json:"claims"`
	Signature string        `json:"signature"`
}
type GenesisApplication struct {
	Issuers map[string]string `json:"license_issuers"`
}

var instanceID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var paidModules = map[string]bool{"amocrm": true, "bitrix": true, "onec": true, "office": true, "whiteboard": true, "planner": true, "conference": true, "servers": true, "channels": true, "bots": true, "diary": true, "family": true, "legal": true, "multiserver": true, "totp": true}

func validateIssuers(issuers map[string]string) error {
	if len(issuers) > 8 {
		return errors.New("too many license issuers")
	}
	for id, value := range issuers {
		key, err := hex.DecodeString(value)
		if err != nil || !hex64.MatchString(value) || !hex64.MatchString(id) {
			return errors.New("invalid issuer key")
		}
		sum := sha256.Sum256(key)
		if hex.EncodeToString(sum[:]) != id {
			return errors.New("issuer key identity mismatch")
		}
	}
	return nil
}
func genesisIssuers(raw []byte) (map[string]string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	if len(raw) > 4096 {
		return nil, errors.New("genesis application too large")
	}
	var config GenesisApplication
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&config); err != nil {
		return nil, err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return nil, errors.New("trailing genesis application")
	}
	if err := validateIssuers(config.Issuers); err != nil {
		return nil, err
	}
	return config.Issuers, nil
}
func verifyLicense(document LicenseDocument, issuers map[string]string, node, network string, now int64) error {
	c := document.Claims
	pub, known := issuers[c.Issuer]
	if !known || c.Schema != "sfera-mesh-license-v1" || c.NodeID != node || c.Network != network || !instanceID.MatchString(c.InstanceID) || c.Modules == nil || len(c.Modules) > 15 {
		return errors.New("invalid license context")
	}
	key, err := hex.DecodeString(pub)
	if err != nil || len(key) != 32 {
		return errors.New("unknown license issuer")
	}
	sig, err := hex.DecodeString(document.Signature)
	if err != nil || len(sig) != 64 || hex.EncodeToString(sig) != document.Signature || !ed25519.Verify(key, canonical(c), sig) {
		return errors.New("invalid company signature")
	}
	if now <= 0 || c.IssuedAt < 0 || c.IssuedAt > int64(^uint64(0)>>1)-300 || c.IssuedAt > now+30 || c.ExpiresAt <= now || c.ExpiresAt <= c.IssuedAt || c.ExpiresAt > c.IssuedAt+300 {
		return errors.New("license expired or invalid interval")
	}
	seen := map[string]bool{}
	for _, module := range c.Modules {
		if !paidModules[module.ID] || seen[module.ID] || module.ExpiresAt < c.ExpiresAt {
			return errors.New("invalid licensed modules")
		}
		seen[module.ID] = true
	}
	return nil
}
func verifyPlacementLicenses(p Placement, issuers map[string]string, at int64) error {
	if p.Body.Domain != "sfera-mesh-placement-v2" || len(issuers) == 0 || len(p.Licenses) != 3 {
		return errors.New("issuer-pinned v2 placement required")
	}
	instances := map[string]bool{}
	for i, document := range p.Licenses {
		if err := verifyLicense(document, issuers, p.Body.Members[i], p.Body.Network, at); err != nil {
			return err
		}
		if instances[document.Claims.InstanceID] {
			return errors.New("duplicate server license instance")
		}
		instances[document.Claims.InstanceID] = true
	}
	return nil
}
