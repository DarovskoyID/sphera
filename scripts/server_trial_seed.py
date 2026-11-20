"""Dedicated trial enrollment/gateway. No validator key is loaded here."""
import json
from pathlib import Path
import signal
import sys
import threading
root=Path('/opt/sphere-point');settings=json.loads((root/'code/preparing.json').read_bytes());version=Path(settings['version'])
sys.path[:0]=[str(version/'scripts'),str(version/'django-server/sfera_server')]
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from sfera_mesh.identity import load_identity,node_id,EnvelopeVerifier
from sfera_mesh.transport import BlobStore
from sfera_mesh.public_transport import TLSMeshServer
from sfera_mesh.consensus_directory import ConsensusDirectory
from sfera_mesh.consensus_updater import ConsensusUpdater
from sfera_mesh.consensus_gateway import ConsensusGateway
from sfera_mesh.point_enrollment import PointEnrollment


def main():
    folder=root/'seed';key=load_identity(folder/'node.key');point=json.loads((root/'data/point.json').read_bytes())
    directory=ConsensusDirectory(str(folder/'directory.sqlite'),point['verifier_binary'],point['genesis'])
    issuer=load_identity(folder/'issuer.key');ca=x509.load_pem_x509_certificate((folder/'ca.pem').read_bytes());ca_key=serialization.load_pem_private_key((folder/'ca.key').read_bytes(),password=None)
    enrollment=PointEnrollment(folder/'enrollment.sqlite',directory,issuer,ca,ca_key);verifier=EnvelopeVerifier(directory.network,node_id(key.public_key().public_bytes_raw()),{node_id(key.public_key().public_bytes_raw()):key.public_key().public_bytes_raw()},str(folder/'replays.sqlite'));store=BlobStore(str(folder/'blobs.sqlite'),max_bytes=1048576)
    service=json.loads((folder/'service.json').read_bytes()) if (folder/'service.json').exists() else {'rpc':'http://127.0.0.1:26657','port':9443}
    updater=ConsensusUpdater(directory,[service['rpc']]).start();stop=threading.Event()
    for sig in (signal.SIGTERM,signal.SIGINT):signal.signal(sig,lambda *_:stop.set())
    server=TLSMeshServer(('0.0.0.0',service['port']),key,verifier,store,certificate=str(folder/'tls.pem'),private_key=str(folder/'tls.key'),directory=directory,consensus_gateway=ConsensusGateway(service['rpc']),point_enrollment=enrollment,readiness=lambda:updater.status()['ready'])
    worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start();print('TRIAL_SEED_LISTENING port=9443',flush=True)
    try:stop.wait()
    finally:server.shutdown();server.server_close();server.drain(10);updater.stop();enrollment.close();verifier.close();store.close();directory.close()


if __name__=='__main__':main()
