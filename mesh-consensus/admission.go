package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
)

type AdmissionApplicationBody struct {
	Domain    string `json:"domain"`
	Network   string `json:"network"`
	Genesis   string `json:"genesis"`
	Policy    string `json:"policy"`
	Operator  string `json:"operator"`
	Evidence  string `json:"evidence"`
	NodeID    string `json:"node_id"`
	PublicKey string `json:"public_key"`
	Role      string `json:"role"`
	IssuedAt  int64  `json:"issued_at"`
	ExpiresAt int64  `json:"expires_at"`
}
type AdmissionApplication struct {
	Body      AdmissionApplicationBody `json:"body"`
	Signature string                   `json:"signature"`
}
type AdmissionApprovalBody struct {
	Domain      string `json:"domain"`
	Network     string `json:"network"`
	Genesis     string `json:"genesis"`
	Policy      string `json:"policy"`
	Committee   string `json:"committee"`
	Application string `json:"application"`
	Version     int64  `json:"version"`
	Previous    string `json:"previous"`
	IssuedAt    int64  `json:"issued_at"`
	ExpiresAt   int64  `json:"expires_at"`
}
type AdmissionApproval struct {
	Body  AdmissionApprovalBody `json:"body"`
	Votes []Consent             `json:"votes"`
}
type AdmissionRevocationBody struct {
	Domain    string `json:"domain"`
	Network   string `json:"network"`
	Genesis   string `json:"genesis"`
	Policy    string `json:"policy"`
	Committee string `json:"committee"`
	NodeID    string `json:"node_id"`
	Operator  string `json:"operator"`
	Revokes   string `json:"revokes"`
	Version   int64  `json:"version"`
	Previous  string `json:"previous"`
	Reason    string `json:"reason"`
	IssuedAt  int64  `json:"issued_at"`
	ExpiresAt int64  `json:"expires_at"`
}
type AdmissionRevocation struct {
	Body  AdmissionRevocationBody `json:"body"`
	Votes []Consent               `json:"votes"`
}
type AdmissionTxBody struct {
	Domain    string `json:"domain"`
	Network   string `json:"network"`
	Operation string `json:"operation"`
}
type AdmissionTransaction struct {
	Body        AdmissionTxBody       `json:"body"`
	Application *AdmissionApplication `json:"application,omitempty"`
	Approval    *AdmissionApproval    `json:"approval,omitempty"`
	Revocation  *AdmissionRevocation  `json:"revocation,omitempty"`
	Rotation    *AdmissionRotation    `json:"rotation,omitempty"`
}
type AdmissionRotationBody struct {
	Domain      string `json:"domain"`
	Previous    string `json:"previous"`
	Application string `json:"application"`
	Approval    string `json:"approval"`
	IssuedAt    int64  `json:"issued_at"`
}
type AdmissionRotation struct {
	Body         AdmissionRotationBody `json:"body"`
	OldSignature string                `json:"old_signature"`
	NewSignature string                `json:"new_signature"`
}
type AdmissionRotationHead struct {
	Proof      AdmissionRotation `json:"proof"`
	OldNode    string            `json:"old_node"`
	NewNode    string            `json:"new_node"`
	AcceptedAt int64             `json:"accepted_at"`
}

func checkAdmissionRotation(s State, proof AdmissionRotation, old AdmissionHead, request AdmissionApplication, approval AdmissionApproval, at int64) error {
	b := proof.Body
	_, domain, issued, _ := admissionVersion(old)
	if domain != "sfera-mesh-admission-approval-lab-v1" || b.Domain != "sfera-mesh-admission-rotation-lab-v1" || b.Previous != old.Digest || b.Application != hex.EncodeToString(digest(request)) || b.Approval != hex.EncodeToString(digest(approval)) || request.Body.Operator != old.Application.Body.Operator || request.Body.NodeID == old.Application.Body.NodeID || b.IssuedAt < issued || b.IssuedAt < approval.Body.IssuedAt || b.IssuedAt > at || at-b.IssuedAt >= 300 || at >= approval.Body.ExpiresAt || !admissionSignature(old.Application.Body.PublicKey, proof.OldSignature, b) || !admissionSignature(request.Body.PublicKey, proof.NewSignature, b) {
		return errors.New("invalid admission key rotation")
	}
	trial := s
	trial.Admissions = nil
	return appendAdmission(&trial, request, canonical(approval), at)
}

type AdmissionHead struct {
	Application AdmissionApplication `json:"application"`
	Approval    json.RawMessage      `json:"approval"`
	Digest      string               `json:"digest"`
	AcceptedAt  int64                `json:"accepted_at"`
}

func admissionCommittee(s State) map[string]string {
	committee := map[string]string{}
	for _, value := range s.PolicyKeys {
		public, _ := hex.DecodeString(value)
		committee[hex.EncodeToString(hashNode(public))] = value
	}
	return committee
}
func admissionSignature(public, signature string, body any) bool {
	p, err := hex.DecodeString(public)
	if err != nil || !hex64.MatchString(public) {
		return false
	}
	sig, err := hex.DecodeString(signature)
	return err == nil && len(sig) == 64 && hex.EncodeToString(sig) == signature && ed25519.Verify(p, canonical(body), sig)
}
func admissionVotes(s State, policy, network, genesis, committeeHash string, body any, votes []Consent) error {
	committee := admissionCommittee(s)
	if len(committee) < 4 || len(committee) > 16 || network != s.Network || genesis != s.GenesisPin || !hex64.MatchString(policy) || s.AdmissionPolicy != "" && policy != s.AdmissionPolicy || committeeHash != hex.EncodeToString(digest(committee)) || len(votes) <= 2*len(committee)/3 || len(votes) > len(committee) {
		return errors.New("invalid admission context or quorum")
	}
	previous := ""
	for _, vote := range votes {
		public, _ := hex.DecodeString(vote.PublicKey)
		if vote.PublicKey <= previous || committee[hex.EncodeToString(hashNode(public))] != vote.PublicKey || !admissionSignature(vote.PublicKey, vote.Signature, body) {
			return errors.New("invalid admission vote")
		}
		previous = vote.PublicKey
	}
	return nil
}
func checkAdmissionApplication(s State, r AdmissionApplication, policy string, at int64) error {
	b := r.Body
	if b.Domain != "sfera-mesh-admission-application-lab-v1" || b.Network != s.Network || b.Genesis != s.GenesisPin || b.Policy != policy || b.Role != "validator" || b.IssuedAt < 0 || b.IssuedAt > at || b.ExpiresAt <= at || b.ExpiresAt <= b.IssuedAt || b.ExpiresAt-b.IssuedAt > 300 {
		return errors.New("invalid admission application context or time")
	}
	for _, v := range []string{b.Operator, b.Evidence, b.NodeID, b.PublicKey} {
		if !hex64.MatchString(v) {
			return errors.New("invalid admission application digest")
		}
	}
	public, _ := hex.DecodeString(b.PublicKey)
	if b.NodeID != hex.EncodeToString(hashNode(public)) || !admissionSignature(b.PublicKey, r.Signature, b) {
		return errors.New("invalid admission applicant signature")
	}
	return nil
}
func admissionVersion(head AdmissionHead) (int64, string, int64, int64) {
	var b struct {
		Body struct {
			Version   int64  `json:"version"`
			Domain    string `json:"domain"`
			IssuedAt  int64  `json:"issued_at"`
			ExpiresAt int64  `json:"expires_at"`
		} `json:"body"`
	}
	_ = json.Unmarshal(head.Approval, &b)
	return b.Body.Version, b.Body.Domain, b.Body.IssuedAt, b.Body.ExpiresAt
}
func appendAdmission(s *State, request AdmissionApplication, decision []byte, at int64) error {
	node := request.Body.NodeID
	history := s.Admissions[node]
	var kind struct {
		Body struct {
			Domain  string `json:"domain"`
			Version int64  `json:"version"`
		} `json:"body"`
	}
	if err := json.Unmarshal(decision, &kind); err != nil {
		return err
	}
	for _, head := range history {
		version, _, _, _ := admissionVersion(head)
		if version == kind.Body.Version {
			if bytes.Equal(canonical(head.Application), canonical(request)) && bytes.Equal(head.Approval, decision) {
				return nil
			}
			return errors.New("admission version conflict")
		}
	}
	version, previous := int64(1), zero
	var old AdmissionHead
	if len(history) > 0 {
		old = history[len(history)-1]
		v, domain, _, _ := admissionVersion(old)
		if domain == "sfera-mesh-admission-revocation-lab-v1" {
			return errors.New("admission node revoked")
		}
		version, previous = v+1, old.Digest
		if at < old.AcceptedAt || request.Body.Operator != old.Application.Body.Operator {
			return errors.New("admission identity or time changed")
		}
	}
	revoking := kind.Body.Domain == "sfera-mesh-admission-revocation-lab-v1"
	approvals, total := 0, 0
	for _, entries := range s.Admissions {
		for _, head := range entries {
			_, domain, _, _ := admissionVersion(head)
			total++
			if domain != "sfera-mesh-admission-revocation-lab-v1" {
				approvals++
			}
		}
	}
	if kind.Body.Version != version || !revoking && (version > 32 || approvals >= 512) || revoking && (version > 33 || total >= 640) || len(history) == 0 && len(s.Admissions) >= 128 {
		return errors.New("admission history bound or version")
	}
	policy := ""
	if revoking {
		var r AdmissionRevocation
		d := json.NewDecoder(bytes.NewReader(decision))
		d.DisallowUnknownFields()
		if err := d.Decode(&r); err != nil {
			return err
		}
		b := r.Body
		policy = b.Policy
		_, _, issued, _ := admissionVersion(old)
		if len(history) == 0 || !bytes.Equal(canonical(old.Application), canonical(request)) || b.NodeID != node || b.Operator != request.Body.Operator || b.Revokes != previous || b.Previous != previous || !hex64.MatchString(b.Reason) || b.IssuedAt < issued || b.IssuedAt > at || b.ExpiresAt <= at || b.ExpiresAt <= b.IssuedAt || b.ExpiresAt-b.IssuedAt > 300 {
			return errors.New("invalid admission revocation anchor or time")
		}
		if err := admissionVotes(*s, policy, b.Network, b.Genesis, b.Committee, b, r.Votes); err != nil {
			return err
		}
		if !bytes.Equal(decision, canonical(r)) {
			return errors.New("noncanonical admission revocation")
		}
	} else {
		var r AdmissionApproval
		d := json.NewDecoder(bytes.NewReader(decision))
		d.DisallowUnknownFields()
		if err := d.Decode(&r); err != nil {
			return err
		}
		b := r.Body
		policy = b.Policy
		if b.Domain != "sfera-mesh-admission-approval-lab-v1" || b.Previous != previous || b.Application != hex.EncodeToString(digest(request)) || b.IssuedAt < request.Body.IssuedAt || b.IssuedAt > at || b.ExpiresAt <= at || b.ExpiresAt > request.Body.ExpiresAt {
			return errors.New("invalid admission approval anchor or time")
		}
		if err := checkAdmissionApplication(*s, request, policy, at); err != nil {
			return err
		}
		if err := admissionVotes(*s, policy, b.Network, b.Genesis, b.Committee, b, r.Votes); err != nil {
			return err
		}
		if !bytes.Equal(decision, canonical(r)) {
			return errors.New("noncanonical admission approval")
		}
	}
	if s.Admissions == nil {
		s.Admissions = map[string][]AdmissionHead{}
	}
	s.Admissions[node] = append(history, AdmissionHead{request, append([]byte(nil), decision...), hex.EncodeToString(digest(json.RawMessage(decision))), at})
	if s.AdmissionPolicy == "" {
		s.AdmissionPolicy = policy
	}
	return nil
}
func applyAdmission(s *State, tx []byte) error {
	if !hex64.MatchString(s.GenesisPin) || len(tx) > 16384 {
		return errors.New("pinned laboratory admission required")
	}
	var r AdmissionTransaction
	d := json.NewDecoder(bytes.NewReader(tx))
	d.DisallowUnknownFields()
	if err := d.Decode(&r); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("trailing admission transaction")
	}
	if !bytes.Equal(tx, canonical(r)) || r.Body.Domain != "sfera-mesh-admission-update-lab-v1" || r.Body.Network != s.Network {
		return errors.New("invalid admission transaction")
	}
	staged := clone(*s)
	switch r.Body.Operation {
	case "approve":
		if r.Application == nil || r.Approval == nil || r.Revocation != nil || r.Rotation != nil {
			return errors.New("invalid admission approval packet")
		}
		if err := appendAdmission(&staged, *r.Application, canonical(r.Approval), s.BlockTime); err != nil {
			return err
		}
	case "revoke":
		if r.Application != nil || r.Approval != nil || r.Revocation == nil || r.Rotation != nil {
			return errors.New("invalid admission revocation packet")
		}
		history := staged.Admissions[r.Revocation.Body.NodeID]
		if len(history) == 0 {
			return errors.New("admission revocation anchor required")
		}
		if err := appendAdmission(&staged, history[len(history)-1].Application, canonical(r.Revocation), s.BlockTime); err != nil {
			return err
		}
	case "rotate":
		if r.Application == nil || r.Approval == nil || r.Revocation == nil || r.Rotation == nil {
			return errors.New("complete admission rotation packet required")
		}
		hash := hex.EncodeToString(digest(r.Rotation))
		if prior, ok := s.AdmissionRotations[hash]; ok {
			source, target := s.Admissions[prior.OldNode], s.Admissions[prior.NewNode]
			if len(source) == 0 || len(target) == 0 || !bytes.Equal(source[len(source)-1].Approval, canonical(r.Revocation)) || !bytes.Equal(canonical(target[0].Application), canonical(r.Application)) || !bytes.Equal(target[0].Approval, canonical(r.Approval)) {
				return errors.New("admission rotation retry conflict")
			}
			return nil
		}
		source := staged.Admissions[r.Revocation.Body.NodeID]
		if len(source) == 0 || len(staged.Admissions[r.Application.Body.NodeID]) != 0 || len(staged.AdmissionRotations) >= 128 {
			return errors.New("admission rotation anchor or history conflict")
		}
		old := source[len(source)-1]
		if err := checkAdmissionRotation(staged, *r.Rotation, old, *r.Application, *r.Approval, s.BlockTime); err != nil {
			return err
		}
		if r.Revocation.Body.Reason != hash {
			return errors.New("rotation-linked revocation required")
		}
		if err := appendAdmission(&staged, old.Application, canonical(r.Revocation), s.BlockTime); err != nil {
			return err
		}
		if err := appendAdmission(&staged, *r.Application, canonical(r.Approval), s.BlockTime); err != nil {
			return err
		}
		if staged.AdmissionRotations == nil {
			staged.AdmissionRotations = map[string]AdmissionRotationHead{}
		}
		staged.AdmissionRotations[hash] = AdmissionRotationHead{*r.Rotation, old.Application.Body.NodeID, r.Application.Body.NodeID, s.BlockTime}
	default:
		return errors.New("unsupported admission operation")
	}
	*s = staged
	return nil
}
func verifyAdmissions(s State) error {
	if len(s.Admissions) == 0 {
		if s.AdmissionPolicy != "" || len(s.AdmissionRotations) != 0 {
			return errors.New("admission policy without history")
		}
		return nil
	}
	if !hex64.MatchString(s.GenesisPin) {
		return errors.New("admission genesis pin required")
	}
	replay := s
	replay.Admissions = nil
	replay.AdmissionPolicy = ""
	for node, history := range s.Admissions {
		if len(history) == 0 {
			return errors.New("empty admission history")
		}
		for _, head := range history {
			if head.Application.Body.NodeID != node || head.AcceptedAt < 0 || head.AcceptedAt > s.BlockTime || head.Digest != hex.EncodeToString(digest(head.Approval)) {
				return errors.New("invalid admission snapshot head")
			}
			before := len(replay.Admissions[node])
			if err := appendAdmission(&replay, head.Application, head.Approval, head.AcceptedAt); err != nil {
				return err
			}
			if len(replay.Admissions[node]) != before+1 {
				return errors.New("duplicate admission snapshot record")
			}
		}
	}
	if replay.AdmissionPolicy != s.AdmissionPolicy {
		return errors.New("admission policy mismatch")
	}
	if len(s.AdmissionRotations) > 128 {
		return errors.New("admission rotation limit")
	}
	for hash, link := range s.AdmissionRotations {
		source, target := s.Admissions[link.OldNode], s.Admissions[link.NewNode]
		if len(source) < 2 || len(target) == 0 || link.AcceptedAt != source[len(source)-1].AcceptedAt || link.AcceptedAt != target[0].AcceptedAt || hash != hex.EncodeToString(digest(link.Proof)) {
			return errors.New("invalid admission rotation history")
		}
		var revoked AdmissionRevocation
		var approved AdmissionApproval
		if json.Unmarshal(source[len(source)-1].Approval, &revoked) != nil || json.Unmarshal(target[0].Approval, &approved) != nil || revoked.Body.Reason != hash {
			return errors.New("invalid rotation revocation link")
		}
		if err := checkAdmissionRotation(s, link.Proof, source[len(source)-2], target[0].Application, approved, link.AcceptedAt); err != nil {
			return err
		}
	}
	return nil
}
