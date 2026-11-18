package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"sort"
)

type ManifestPageRequest struct {
	Cluster string `json:"cluster"`
	Offset  int    `json:"offset"`
	Limit   int    `json:"limit"`
}
type ManifestPage struct {
	Meta    StateProof   `json:"meta"`
	Entries []StateProof `json:"entries"`
	Offset  int          `json:"offset"`
}

func makeManifestPage(s State, request []byte) (ManifestPage, error) {
	var query ManifestPageRequest
	var page ManifestPage
	if len(request) > 512 || json.Unmarshal(request, &query) != nil || !bytes.Equal(request, canonical(query)) || !hex64.MatchString(query.Cluster) || query.Offset < 0 || query.Limit < 1 || query.Limit > 64 {
		return page, errors.New("invalid manifest page request")
	}
	head, ok := s.Manifests[query.Cluster]
	if !ok || head.Record.Body.Sizes == nil || query.Offset > len(head.Record.Body.Digests) {
		return page, errors.New("sized manifest page required")
	}
	if s.StateCommitment != stateMerkleScheme || s.Height < 1 {
		return page, errors.New("compact proof genesis required")
	}
	leaves := stateLeaves(s)
	rows := stateRows(leaves)
	metaKey := "manifest/" + query.Cluster + "/meta"
	metaIndex := sort.Search(len(leaves), func(i int) bool { return leaves[i].Key >= metaKey })
	if metaIndex >= len(leaves) || leaves[metaIndex].Key != metaKey || metaIndex < len(head.Record.Body.Digests) {
		return page, errors.New("invalid manifest leaf layout")
	}
	meta := stateProofFromTree(s, leaves, rows, metaIndex)
	page = ManifestPage{Meta: meta, Entries: []StateProof{}, Offset: query.Offset}
	stop := query.Offset + query.Limit
	if stop > len(head.Record.Body.Digests) {
		stop = len(head.Record.Body.Digests)
	}
	for offset, digest := range head.Record.Body.Digests[query.Offset:stop] {
		index := metaIndex - len(head.Record.Body.Digests) + query.Offset + offset
		if leaves[index].Key != "manifest/"+query.Cluster+"/entry/"+digest {
			return page, errors.New("nonconsecutive manifest leaves")
		}
		entry := stateProofFromTree(s, leaves, rows, index)
		page.Entries = append(page.Entries, entry)
	}
	return page, nil
}
