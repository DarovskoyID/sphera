#!/usr/bin/env bash
# Separate company service. Never touches user content or the main database.
set -euo pipefail
umask 077
stage="${1:-}"
key=/etc/sfera/commercial-github
app=/opt/sfera-commercial
repo=git@github.com:DarovskoyID/sphera-commercial.git
[[ "$stage" == prepare || "$stage" == deploy ]] || { echo 'Expected prepare or deploy'; exit 2; }
[[ $(id -u) == 0 ]] || { echo 'Run as root'; exit 2; }
mkdir -p /etc/sfera
if [[ ! -f "$key" ]]; then
  ssh-keygen -q -t ed25519 -N '' -C sfera-commercial-readonly -f "$key"
fi
if [[ "$stage" == prepare ]]; then
  echo 'COMMERCIAL_DEPLOY_PUBLIC_KEY_BEGIN'
  cat "$key.pub"
  echo 'COMMERCIAL_DEPLOY_PUBLIC_KEY_END'
  exit 0
fi
command -v docker >/dev/null
docker compose version >/dev/null
export GIT_SSH_COMMAND="ssh -i $key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if [[ ! -e "$app" ]]; then
  git clone --branch main "$repo" "$app"
else
  [[ -d "$app/.git" ]] && [[ $(git -C "$app" remote get-url origin) == "$repo" ]] || { echo 'Unexpected existing service directory'; exit 1; }
  [[ -z $(git -C "$app" status --porcelain) ]] || { echo 'Refusing to overwrite local service changes'; exit 1; }
  git -C "$app" fetch origin main
  git -C "$app" merge --ff-only origin/main
fi
cd "$app"
if [[ ! -f .env ]]; then
  python3 - <<'PY'
import os, secrets
with os.fdopen(os.open('.env', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as out:
    out.write('COMMERCIAL_SECRET_KEY=' + secrets.token_urlsafe(64) + '\n')
    out.write('COMMERCIAL_DB_PASSWORD=' + secrets.token_urlsafe(48) + '\n')
    out.write('COMMERCIAL_ALLOWED_HOSTS=127.0.0.1,localhost\nCOMMERCIAL_DEBUG=0\n')
PY
fi
docker compose up -d --build
ready=0
for attempt in $(seq 1 90); do
  if curl --fail --silent http://127.0.0.1:8020/health/ >/dev/null; then ready=1; break; fi
  sleep 2
done
[[ "$ready" == 1 ]] || { echo 'Commercial API did not become healthy'; exit 1; }
docker compose exec -T commercial-api python manage.py bootstrap_operator --token-file /app/state/operator.json
if ! docker compose exec -T commercial-api test -f /app/state/core-instance.json; then
  docker compose exec -T commercial-api python manage.py issue_instance --name company-node --token-file /app/state/core-instance.json
fi
docker compose cp commercial-api:/app/state/core-instance.json /etc/sfera/commercial-instance.json
chmod 600 /etc/sfera/commercial-instance.json
python3 - <<'PY'
import json, os
from pathlib import Path
data = json.loads(Path('/etc/sfera/commercial-instance.json').read_text())
target = Path('/etc/sfera/commercial.env')
fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as out:
    out.write('SFERA_COMMERCIAL_API_URL=http://127.0.0.1:8020\n')
    out.write('SFERA_COMMERCIAL_INSTANCE_ID=' + data['instance_id'] + '\n')
    out.write('SFERA_COMMERCIAL_API_KEY=' + data['api_key'] + '\n')
target.chmod(0o600)
from urllib.request import Request, urlopen
request = Request('http://127.0.0.1:8020/v1/catalog',
    data=json.dumps({'instance_id': data['instance_id']}).encode(),
    headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + data['api_key']})
with urlopen(request, timeout=10) as response:
    catalog = json.load(response)
assert len(catalog['modules']) == 15
assert all(module['paid'] and module['scope'] == 'instance' for module in catalog['modules'])
PY
mkdir -p /etc/systemd/system/sfera-daphne.service.d
printf '[Service]\nEnvironmentFile=/etc/sfera/commercial.env\n' > /etc/systemd/system/sfera-daphne.service.d/commercial.conf
systemctl daemon-reload
systemctl restart sfera-daphne
systemctl is-active --quiet sfera-daphne
echo 'Commercial API healthy; instance credential connected to the core. No subscriptions activated automatically.'
