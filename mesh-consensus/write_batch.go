package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
)

// One transaction reserves an entire bounded generation. Individual holder
// signatures retain the ordinary write-v2 authentication and replay rules.
type WriteBatchBody struct {
	Domain  string        `json:"domain"`
	Network string        `json:"network"`
	Writes  []WriteRecord `json:"writes"`
}
type WriteBatch struct {
	Body WriteBatchBody `json:"body"`
}

func applyWriteBatch(s *State, tx []byte) error {
	var batch WriteBatch
	if len(tx) > 262144 {
		return errors.New("write batch too large")
	}
	d := json.NewDecoder(bytes.NewReader(tx))
	d.DisallowUnknownFields()
	if err := d.Decode(&batch); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return errors.New("trailing write batch")
	}
	if !bytes.Equal(tx, canonical(batch)) || batch.Body.Domain != "sfera-mesh-write-batch-v2" || batch.Body.Network != s.Network || len(batch.Body.Writes) < 1 || len(batch.Body.Writes) > 128 {
		return errors.New("invalid write batch context")
	}
	// applyWrite only mutates WriteQueue. Never expose a successful prefix,
	// including on direct apply callers, CheckTx or failed FinalizeBlock txs.
	pending := *s
	pending.WriteQueue = make(map[string]WriteHead, len(s.WriteQueue))
	for id, head := range s.WriteQueue {
		pending.WriteQueue[id] = head
	}
	previous := ""
	for _, record := range batch.Body.Writes {
		if record.Body.Domain != "sfera-mesh-write-v2" || record.Body.RequestID <= previous {
			return errors.New("sorted distinct content-bound writes required")
		}
		if err := applyWrite(&pending, canonical(record)); err != nil {
			return err
		}
		previous = record.Body.RequestID
	}
	s.WriteQueue = pending.WriteQueue
	return nil
}
