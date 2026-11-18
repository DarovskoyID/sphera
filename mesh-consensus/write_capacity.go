package main

import "errors"

// A committed work item reserves one unique manifest slot until inclusion.
// Direct manifest writers must preserve these reservations as well.
func checkWriteCapacity(s State, cluster string, additions map[string]int64) error {
	values := map[string]int64{}
	include := func(digest string, size int64) error {
		if old := values[digest]; old > 0 && size > 0 && old != size {
			return errors.New("queued ciphertext size conflict")
		}
		if _, exists := values[digest]; !exists || size > 0 {
			values[digest] = size
		}
		return nil
	}
	if head, ok := s.Manifests[cluster]; ok {
		for i, value := range head.Record.Body.Digests {
			size := int64(0)
			if head.Record.Body.Sizes != nil {
				size = (*head.Record.Body.Sizes)[i]
			}
			if err := include(value, size); err != nil {
				return err
			}
		}
	}
	for _, head := range s.WriteQueue {
		b := head.Record.Body
		if b.Cluster == cluster {
			if err := include(b.Digest, b.Size); err != nil {
				return err
			}
		}
	}
	for value, size := range additions {
		if err := include(value, size); err != nil {
			return err
		}
	}
	if len(values) > 512 {
		return errors.New("write manifest capacity exhausted")
	}
	return nil
}
