"""Loopback lab replacement controller; requires fresh quorum resource assessments."""
import argparse
import json
import os
from pathlib import Path
import signal
import sqlite3
import sys
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'django-server'/'sfera_server'))
from sfera_mesh.consensus_directory import ConsensusDirectory
from sfera_mesh.identity import load_identity, node_id, EnvelopeVerifier
from sfera_mesh.replication import ReplicaJournal
from sfera_mesh.replacement import ReplacementController
from sfera_mesh.failure_coordinator import FailureCoordinator
from sfera_mesh.capacity_renewal import CapacityRenewal
from sfera_mesh.capacity_worker import CapacityWorker
from sfera_mesh.publication import ReplicaPublication
from sfera_mesh.storage import Storage
from sfera_mesh.storage_publication import StoragePublication
from sfera_mesh.write_queue import ConsensusWriteQueue
from sfera_mesh.transfer_consensus import TransferCoordinator


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ('identity','roster','state','replicas','replays','verified-state','verifier','genesis','rpc'):
        parser.add_argument('--'+argument,required=True)
    parser.add_argument('--cluster',action='append',required=True)
    parser.add_argument('--reserve-preparation',action='store_true',help='persist mandatory target reservation before each preparation write; requires bounded target stores and a current holder identity')
    parser.add_argument('--failure-assessors',help='pinned assessor map: assessor ID -> observer/endpoint')
    parser.add_argument('--failure-state',help='separate failure coordinator SQLite file')
    parser.add_argument('--capacity-assessors',help='pinned assessor map: assessor ID -> observer/endpoint')
    parser.add_argument('--capacity-domains',help='pinned map: storage node ID -> failure domain')
    parser.add_argument('--capacity-state',help='separate positive capacity renewal SQLite file')
    parser.add_argument('--publication-state-directory',help='opt in to replication and durable consensus index publication for staged journal blocks')
    parser.add_argument('--storage-payloads',help='laboratory ciphertext payload database to drain into publication')
    parser.add_argument('--storage-index',help='paired laboratory block index and durable publication queue')
    parser.add_argument('--consensus-queue-state',help='opt in to three-holder signed work replicated by consensus; separate local outbox file')
    parser.add_argument('--transfer-state',help='separate outbox for three-holder consensus transfer acknowledgements')
    args = parser.parse_args()
    if args.consensus_queue_state and not args.publication_state_directory:
        parser.error('--consensus-queue-state requires --publication-state-directory')
    if args.transfer_state and not args.publication_state_directory:
        parser.error('--transfer-state requires --publication-state-directory')
    if any((args.storage_payloads,args.storage_index)) and not all((args.storage_payloads,args.storage_index,args.publication_state_directory)):
        parser.error('Both --storage-* files require --publication-state-directory')
    if bool(args.failure_assessors)!=bool(args.failure_state):
        parser.error('--failure-assessors and --failure-state must be supplied together')
    if any((args.capacity_assessors,args.capacity_domains,args.capacity_state)) and not all((args.capacity_assessors,args.capacity_domains,args.capacity_state)):
        parser.error('All three --capacity-* configuration paths are required together')
    if not 1 <= len(args.cluster) <= 16 or len(set(args.cluster)) != len(args.cluster):
        parser.error('Specify 1–16 distinct clusters')
    state_paths = [str(Path(value).resolve()) for value in (args.state,args.replicas,args.replays,args.verified_state)]
    if args.failure_state: state_paths.append(str(Path(args.failure_state).resolve()))
    if args.capacity_state: state_paths.append(str(Path(args.capacity_state).resolve()))
    if args.consensus_queue_state: state_paths.append(str(Path(args.consensus_queue_state).resolve()))
    if args.transfer_state: state_paths.append(str(Path(args.transfer_state).resolve()))
    if args.storage_payloads: state_paths.extend(str(Path(value).resolve()) for value in (args.storage_payloads,args.storage_index))
    state_paths=[os.path.normcase(value) for value in state_paths]
    if len(set(state_paths)) != len(state_paths):
        parser.error('State files must be separate')
    inputs={os.path.normcase(str(Path(value).resolve())) for value in
            (args.identity,args.roster,args.verifier,args.genesis,args.failure_assessors,args.capacity_assessors,args.capacity_domains) if value}
    if set(state_paths)&inputs:
        parser.error('State files must be separate from input files')
    config = json.loads(Path(args.roster).read_bytes())
    if set(config) != {'network','nodes'} or not isinstance(config['nodes'],dict) or not 3 <= len(config['nodes']) <= 64:
        parser.error('Expected explicit network and 3–64 pinned nodes')
    key = load_identity(args.identity)
    verifier = EnvelopeVerifier(config['network'],node_id(key.public_key().public_bytes_raw()),
        {identity:bytes.fromhex(item['public_key']) for identity,item in config['nodes'].items()},args.replays)
    directory = journal = controller = failures = capacity = capacity_worker = storage = queue = transfers = None
    stopped = threading.Event()
    for name in (signal.SIGINT,signal.SIGTERM):
        signal.signal(name,lambda *_:stopped.set())
    try:
        directory = ConsensusDirectory(args.verified_state,args.verifier,args.genesis)
        journal = ReplicaJournal(args.replicas,key,verifier,{identity:item['endpoint'] for identity,item in config['nodes'].items()},require_consensus=True,reserve_preparation=args.reserve_preparation)
        controller = ReplacementController(args.state,directory,args.rpc,journal)
        publication = ReplicaPublication(args.publication_state_directory,directory,args.rpc,journal) if args.publication_state_directory else None
        queue = ConsensusWriteQueue(args.consensus_queue_state,publication) if args.consensus_queue_state else None
        transfers = TransferCoordinator(args.transfer_state,publication) if args.transfer_state else None
        storage = Storage(args.storage_payloads,args.storage_index) if args.storage_payloads else None
        storage_writer = StoragePublication(storage,publication,queue) if storage is not None else None
        if args.failure_assessors:
            failures = FailureCoordinator(args.failure_state,directory,args.rpc,key,verifier,json.loads(Path(args.failure_assessors).read_bytes()))
        if args.capacity_state:
            capacity = CapacityRenewal(args.capacity_state,directory,args.rpc,key,verifier,json.loads(Path(args.capacity_assessors).read_bytes()),json.loads(Path(args.capacity_domains).read_bytes()))
            capacity_worker = CapacityWorker(capacity).start()
        previous = {}
        while not stopped.is_set():
            if capacity_worker is not None:
                worker_status = capacity_worker.status()
                if worker_status['error'] and previous.get('capacity_worker_error') != worker_status['error']:
                    print(json.dumps({'capacity_worker':{'state':'failed','error':worker_status['error']}}),flush=True)
                    previous['capacity_worker_error'] = worker_status['error']
                for node, capacity_status in worker_status['nodes'].items():
                    if previous.get((node,'capacity'))!=capacity_status:
                        print(json.dumps({'node':node,'capacity':capacity_status}),flush=True)
                        previous[(node,'capacity')] = capacity_status
            for cluster in args.cluster:
                if stopped.is_set(): break
                if failures is not None:
                    failure_status = failures.step(cluster)
                    if previous.get((cluster,'failure'))!=failure_status:
                        print(json.dumps({'cluster':cluster,'failure':failure_status}),flush=True)
                        previous[(cluster,'failure')] = failure_status
                status = controller.step(cluster)
                summary = {'state':status['state'],'error':status.get('error')}
                if summary != previous.get(cluster):
                    print(json.dumps({'cluster':cluster,**summary}),flush=True)
                    previous[cluster] = summary
                if publication is not None:
                    try:
                        publication_status = storage_writer.step(cluster) if storage_writer is not None else queue.step(cluster) if queue is not None else publication.step(cluster)
                    except (ValueError,OSError,sqlite3.Error):
                        publication_status = {'state':'waiting','error':'publication_unavailable'}
                    if previous.get((cluster,'publication')) != publication_status:
                        print(json.dumps({'cluster':cluster,'publication':publication_status}),flush=True)
                        previous[(cluster,'publication')] = publication_status
                if transfers is not None:
                    try:
                        transfer_status=transfers.step(cluster)
                    except (ValueError,OSError,sqlite3.Error):
                        transfer_status={'state':'waiting','complete':False,'error':'transfer_unavailable'}
                    summary={key:value for key,value in transfer_status.items() if key!='finality'}
                    if previous.get((cluster,'transfer'))!=summary:
                        print(json.dumps({'cluster':cluster,'transfer':summary}),flush=True)
                        previous[(cluster,'transfer')]=summary
            try:
                cleanup=journal.release_preparation_reservations(directory)
            except (ValueError,OSError):
                cleanup={'error':'reservation_cleanup_unavailable'}
            if cleanup.get('released') or cleanup.get('error') and previous.get('reservation_cleanup')!=cleanup:
                print(json.dumps({'reservation_cleanup':cleanup}),flush=True)
            previous['reservation_cleanup']=cleanup
            stopped.wait(2)
        return 0
    finally:
        if capacity_worker is not None and not capacity_worker.stop():
            raise RuntimeError('capacity_worker_shutdown_timeout')
        if capacity is not None: capacity.close()
        if failures is not None: failures.close()
        if controller is not None: controller.close()
        if queue is not None: queue.close()
        if transfers is not None: transfers.close()
        if storage is not None: storage.close()
        if journal is not None: journal.close()
        if directory is not None: directory.close()
        verifier.close()


if __name__ == '__main__':
    sys.exit(main())
