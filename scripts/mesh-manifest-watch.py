"""One loopback sized-index request; exits after verified consensus inclusion."""
import argparse
import json
from pathlib import Path
import signal
import sys
import threading

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'django-server'/'sfera_server'))
from sfera_mesh.consensus_directory import ConsensusDirectory
from sfera_mesh.identity import load_identity,node_id,EnvelopeVerifier
from sfera_mesh.manifest_publisher import ManifestPublisher


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for argument in ('identity','roster','state','replays','verified-state','verifier','genesis','rpc','cluster','sizes'):
        parser.add_argument('--'+argument,required=True)
    args=parser.parse_args()
    paths=[str(Path(path).resolve()) for path in (args.state,args.replays,args.verified_state)]
    inputs={str(Path(path).resolve()) for path in (args.identity,args.roster,args.verifier,args.genesis,args.sizes)}
    if len(set(paths))!=3 or set(paths)&inputs:
        parser.error('State files must be separate from each other and all input files')
    raw=Path(args.sizes).read_bytes()
    if len(raw)>16384: parser.error('Size map exceeds laboratory bound')
    sizes=json.loads(raw)
    config=json.loads(Path(args.roster).read_bytes())
    if set(config)!={'network','nodes'} or not isinstance(config['nodes'],dict) or not 3<=len(config['nodes'])<=64:
        parser.error('Expected explicit network and 3–64 pinned nodes')
    key=load_identity(args.identity)
    verifier=EnvelopeVerifier(config['network'],node_id(key.public_key().public_bytes_raw()),{identity:bytes.fromhex(item['public_key']) for identity,item in config['nodes'].items()},args.replays)
    directory=publisher=None
    stopped=threading.Event()
    for name in (signal.SIGINT,signal.SIGTERM): signal.signal(name,lambda *_:stopped.set())
    try:
        directory=ConsensusDirectory(args.verified_state,args.verifier,args.genesis)
        publisher=ManifestPublisher(args.state,directory,args.rpc,key,verifier,{identity:item['endpoint'] for identity,item in config['nodes'].items()},cluster=args.cluster,sizes=sizes)
        previous=None
        while not stopped.is_set():
            status=publisher.step()
            if status!=previous: print(json.dumps(status),flush=True); previous=status
            if status['state']=='confirmed': return 0
            stopped.wait(2)
        return 0
    finally:
        if publisher is not None: publisher.close()
        if directory is not None: directory.close()
        verifier.close()


if __name__=='__main__': sys.exit(main())
