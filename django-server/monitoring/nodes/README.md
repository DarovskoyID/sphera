# Extra scrape targets (auto-discovered)

Prometheus `file_sd` watches this folder. Drop a `*.json` here to add a node that
serves `/metrics` — it is scraped and charted per-instance in Grafana automatically.

Example `node-2.json`:
```json
[{ "targets": ["10.8.0.2:8010"], "labels": { "service": "django", "node": "node-2" } }]
```
The cluster node-setup script writes these when a WireGuard node joins.
