"""Public TLS relay for bounded consensus proofs/transactions, never admin RPC."""
import base64
import json
from urllib.parse import urlsplit
from .storage import canonical


class GatewaySource(str):
    """Explicit opt-in source: plain remote strings remain forbidden local RPC."""
    def __new__(cls,url,*,ca_certificate=None):
        from .public_transport import endpoint_url
        result=super().__new__(cls,endpoint_url(url))
        result.context=None
        if ca_certificate is not None:
            import ssl
            from pathlib import Path
            if not isinstance(ca_certificate,str) or not Path(ca_certificate).is_absolute():raise ValueError('absolute_gateway_ca_required')
            result.context=ssl.create_default_context()
            result.context.load_verify_locations(cafile=ca_certificate)
        return result


def validate_request(value):
    if not isinstance(value,dict) or set(value)!={'jsonrpc','id','method','params'} or value['jsonrpc']!='2.0' or value['id']!=1:raise ValueError('gateway_rpc_schema')
    method=value['method'];params=value['params']
    if not isinstance(params,dict):raise ValueError('gateway_rpc_params')
    if method=='status':
        if params:raise ValueError('gateway_status_params')
    elif method=='abci_query':
        if set(params)!={'path','prove'} or params['path'] not in ('/snapshot','/committee-history') or params['prove'] is not False:raise ValueError('gateway_query_not_public')
    elif method=='commit':
        if set(params)!={'height'} or not isinstance(params['height'],str) or not params['height'].isdecimal() or not 1<=int(params['height'])<=2**63-1:raise ValueError('gateway_commit_height')
    elif method=='broadcast_tx_sync':
        if set(params)!={'tx'} or not isinstance(params['tx'],str) or len(params['tx'])>90000:raise ValueError('gateway_transaction_size')
        raw=base64.b64decode(params['tx'],validate=True)
        if len(raw)>65536 or not raw or canonical(json.loads(raw))!=raw:raise ValueError('gateway_canonical_transaction_required')
    else:raise ValueError('gateway_rpc_method_forbidden')
    return value


class ConsensusGateway:
    def __init__(self,address):
        from .consensus_directory import validate_address
        if isinstance(address,GatewaySource):raise ValueError('gateway_must_relay_only_local_validator')
        validate_address(address);self.address=address
    def execute(self,value):
        from .consensus_directory import rpc,ConsensusUnavailable,ConsensusTransactionPending
        value=validate_request(value)
        try:return {'jsonrpc':'2.0','id':1,'result':rpc(self.address,value['method'],value['params'])}
        except ConsensusTransactionPending:
            return {'jsonrpc':'2.0','id':1,'error':{'code':-32603,'message':'Internal error','data':'tx already exists in cache'}}
        except (ConsensusUnavailable,OSError) as error:
            if hasattr(error,'close'):error.close()
            return {'jsonrpc':'2.0','id':1,'error':{'code':-32000,'message':'consensus_data_unavailable'}}
