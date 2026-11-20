"""Install an entry-owned TURN service without publishing its credential secret."""
import ipaddress,json,os,pwd,secrets,shutil,subprocess
from pathlib import Path


def install(app,host,user,run,own,private_json):
    address=ipaddress.ip_address(host)
    if address.version!=4 or not address.is_global:raise ValueError('public_turn_address_required')
    marker=app/'turn';receipt=marker/'installation.json'
    if shutil.which('turnserver') and not receipt.exists():raise ValueError('unmanaged_turn_installation_preserved')
    marker.mkdir(mode=0o700,exist_ok=True)
    expected={'domain':'sphere-entry-turn-v1','host':host}
    if receipt.exists() and json.loads(receipt.read_bytes())!=expected:raise ValueError('turn_installation_identity_changed')
    if not receipt.exists():private_json(receipt,expected,marker.stat())
    if not shutil.which('turnserver'):
        # Prevent the package's unconfigured vendor service from starting.
        run(['systemctl','mask','coturn.service'])
        environment={**os.environ,'DEBIAN_FRONTEND':'noninteractive'}
        run(['apt-get','update','-qq'],env=environment,timeout=180)
        run(['apt-get','install','-y','--no-install-recommends','coturn'],env=environment,timeout=300)
    try:turn_user=pwd.getpwnam('sphere-turn')
    except KeyError:
        run(['useradd','--system','--user-group','--home-dir','/nonexistent','--shell','/usr/sbin/nologin','sphere-turn'])
        turn_user=pwd.getpwnam('sphere-turn')
    if turn_user.pw_uid==0 or turn_user.pw_dir!='/nonexistent':raise ValueError('managed_turn_account_required')
    data=app/'data';data.mkdir(mode=0o700,exist_ok=True);own(data,user.pw_uid,user.pw_gid,0o700)
    secret_path=data/'turn.json'
    if secret_path.exists():
        if secret_path.is_symlink():raise ValueError('regular_turn_secret_required')
        value=json.loads(secret_path.read_bytes())
        if value.get('host')!=host or set(value)!={'host','secret','port','ttl'} or len(value['secret'])!=64:raise ValueError('turn_configuration_changed')
    else:
        value={'host':host,'secret':secrets.token_hex(32),'port':3478,'ttl':3600};private_json(secret_path,value,user)
    directory=Path('/etc/sphere-turn')
    if directory.is_symlink():raise ValueError('regular_turn_directory_required')
    directory.mkdir(mode=0o750,exist_ok=True);own(directory,0,turn_user.pw_gid,0o750)
    lines=['listening-port=3478','listening-ip=0.0.0.0','external-ip='+host,'realm='+host,
        'fingerprint','use-auth-secret','static-auth-secret='+value['secret'],
        'min-port=49160','max-port=49260','relay-threads=1','user-quota=12','total-quota=256',
        'bps-capacity=16000000','max-bps=2000000','stale-nonce=600','no-tls','no-dtls','no-tcp-relay','no-multicast-peers','no-cli',
        'pidfile=/run/sphere-turn/turn.pid','userdb=/run/sphere-turn/turn.sqlite','log-file=stdout']
    for network in ('0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16',
                    '172.16.0.0/12','192.0.0.0/24','192.168.0.0/16','198.18.0.0/15','224.0.0.0/4','240.0.0.0/4',
                    '::1/128','fc00::/7','fe80::/10','ff00::/8'):
        subnet=ipaddress.ip_network(network)
        lines.append('denied-peer-ip='+str(subnet.network_address)+'-'+str(subnet.broadcast_address))
    config=directory/'turnserver.conf'
    if config.is_symlink():raise ValueError('regular_turn_configuration_required')
    config.write_text('\n'.join(lines)+'\n');own(config,0,turn_user.pw_gid,0o640)
    unit=Path('/etc/systemd/system/sphere-turn.service')
    unit.write_text('''[Unit]
Description=Sphere entry TURN relay
After=network-online.target
[Service]
User=sphere-turn
Group=sphere-turn
RuntimeDirectory=sphere-turn
RuntimeDirectoryMode=0700
ExecStart=/usr/bin/turnserver -c /etc/sphere-turn/turnserver.conf
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/run/sphere-turn
UMask=0077
[Install]
WantedBy=multi-user.target
''')
    if shutil.which('ufw'):
        status=run(['ufw','status'],capture_output=True,text=True).stdout
        if 'Status: active' in status:
            for rule in ('3478/tcp','3478/udp','49160:49260/udp'):run(['ufw','allow',rule])
    run(['systemctl','daemon-reload']);run(['systemctl','enable','sphere-turn.service']);run(['systemctl','restart','sphere-turn.service'])
    # A process can be briefly active before coturn rejects its configuration.
    import time
    time.sleep(3)
    run(['systemctl','is-active','--quiet','sphere-turn.service'])
    return {'host':host,'turn_service':'sphere-turn.service','port':3478,'credential_secret_exported':False}
