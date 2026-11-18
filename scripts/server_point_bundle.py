"""Build the two-command consumer bootstrap; embeds independent public release trust."""
import argparse
import hashlib
from pathlib import Path
import tempfile
import zipapp
import shutil
from release_v1 import parse,canonical,trust_document


def bundle(source,trust_path,output,profile_url,installer_url):
    source=Path(source);output=Path(output);trust=parse(Path(trust_path).read_bytes());trust_document(trust)
    for url in (profile_url,installer_url):
        from urllib.parse import urlsplit
        v=urlsplit(url)
        if v.scheme!='https' or not v.hostname or v.username or v.password or v.fragment or any(c in url for c in "'\n\r\\"):raise ValueError('literal_https_bootstrap_url_required')
    if output.exists():raise ValueError('new_point_bootstrap_output_required')
    output.mkdir(mode=0o700)
    with tempfile.TemporaryDirectory(prefix='sphere-bootstrap-build-') as temporary:
        root=Path(temporary)
        for name in ('server_point_install.py','release_v1.py','server_release_client.py','server_release.py','server_install.py','server_environment.py'):
            shutil.copyfile(source/'scripts'/name,root/name)
        (root/'trust.public.json').write_bytes(canonical(trust))
        zipapp.create_archive(root,output/'sphere-install.pyz',main='server_point_install:entry',compressed=True)
    digest=hashlib.sha256((output/'sphere-install.pyz').read_bytes()).hexdigest()
    shell="""#!/usr/bin/env bash
set -euo pipefail
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then echo 'Пока поддерживается Linux x86_64.' >&2; exit 2; fi
if [ "$(id -u)" != 0 ]; then
  if [ -x /usr/bin/sudo ]; then exec /usr/bin/sudo /bin/bash "$0" "$@"; fi
  echo 'Для установки нужны права администратора сервера.' >&2; exit 2
fi
if ! command -v apt-get >/dev/null; then echo 'Этот установщик рассчитан на Debian/Ubuntu.' >&2; exit 2; fi
export DEBIAN_FRONTEND=noninteractive
umask 077
log=/var/log/sphere-point-install.log
printf 'Подготавливаю поинт. Это может занять несколько минут.\\n'
if ! { apt-get update -qq && apt-get install -y -qq python3 python3-venv python3-cryptography ca-certificates curl; } >> "$log" 2>&1; then
  printf 'Не удалось подготовить систему. Журнал: %s\\n' "$log" >&2; exit 2
fi
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' 'INSTALLER_URL' -o "$temporary/sphere-install.pyz"
printf '%s  %s\\n' 'INSTALLER_SHA256' "$temporary/sphere-install.pyz" | sha256sum --check --status
if python3 -I -B "$temporary/sphere-install.pyz" --profile 'PROFILE_URL' "$@" >> "$log" 2>&1; then
  printf 'Готово. Поинт работает.\\n'
else
  tail -n 1 "$log" >&2
  printf 'Журнал установки: %s\\n' "$log" >&2; exit 2
fi
""".replace('INSTALLER_URL',installer_url).replace('INSTALLER_SHA256',digest).replace('PROFILE_URL',profile_url)
    (output/'sphere-install.sh').write_text(shell,encoding='utf-8',newline='\n');(output/'sphere-install.sh').chmod(0o755)
    return {'installer_sha256':digest,'root_key_id':trust['root_key_id'],'role':'point','commands':2}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('source','trust','output','profile-url','installer-url'):parser.add_argument('--'+name,required=True)
    args=parser.parse_args();print(canonical(bundle(args.source,args.trust,args.output,args.profile_url,args.installer_url)).decode())


if __name__=='__main__':main()
