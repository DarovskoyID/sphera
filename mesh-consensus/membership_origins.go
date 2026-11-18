package main

// borrowedFromHistory only recognizes uninterrupted, strictly ordered entries.
// A timestamp tie or a second initial allocation cannot authorize a return.
func borrowedFromHistory(s State, node, cluster string) bool {
	type entry struct {
		cluster string
		head    PlacementHead
	}
	entries := []entry{}
	for key, history := range s.PlacementHistory {
		var start *PlacementHead
		for i := range history {
			present := false
			for _, id := range history[i].Record.Body.Members {
				if id == node {
					present = true
				}
			}
			if !present {
				start = nil
			} else if start == nil {
				start = &history[i]
			}
		}
		if start != nil {
			entries = append(entries, entry{key, *start})
		}
	}
	if len(entries) != 2 {
		return false
	}
	if entries[0].head.AcceptedAt > entries[1].head.AcceptedAt {
		entries[0], entries[1] = entries[1], entries[0]
	}
	return entries[0].head.AcceptedAt > 0 && entries[0].head.AcceptedAt < entries[1].head.AcceptedAt && entries[1].cluster == cluster && entries[1].head.Record.Body.Epoch > 1
}
