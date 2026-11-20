import base64
import unittest
import io,json
from unittest.mock import patch
from .consensus_gateway import GatewaySource,ConsensusGateway,validate_request
from .consensus_directory import validate_address
from .storage import canonical


class GatewayTests(unittest.TestCase):
    def request(self,method,params):return {'jsonrpc':'2.0','id':1,'method':method,'params':params}
    def test_explicit_https_source_without_opening_local_rpc_policy(self):
        validate_address(GatewaySource('https://seed.example:8443'))
        for url in ('http://outside.example:26657','https://outside.example:8443'):
            with self.assertRaises(ValueError):validate_address(url)
        with self.assertRaises(ValueError):ConsensusGateway(GatewaySource('https://seed.example'))
    def test_admin_rpc_unknown_query_and_noncannonical_tx_rejected(self):
        for value in (self.request('unsafe_flush_mempool',{}),self.request('abci_query',{'path':'/private','prove':False}),self.request('commit',{'height':'-1'}),self.request('broadcast_tx_sync',{'tx':base64.b64encode(b'{ "x":1}').decode()})):
            with self.assertRaises(ValueError):validate_request(value)
        validate_request(self.request('broadcast_tx_sync',{'tx':base64.b64encode(canonical({'body':{'domain':'test'}})).decode()}))
    def test_proof_queries_bounded_and_read_only(self):
        for value in (self.request('abci_query',{'path':'/snapshot','prove':False}),self.request('commit',{'height':'3'}),self.request('status',{})):self.assertIs(validate_request(value),value)

    def test_duplicate_transaction_remains_pending_through_gateway(self):
        gateway=ConsensusGateway('http://127.0.0.1:26657')
        request=self.request('broadcast_tx_sync',{'tx':base64.b64encode(canonical({'body':{'domain':'test'}})).decode()})
        with patch('sfera_mesh.consensus_directory._http_opener') as opener:
            opener.return_value.open.side_effect=lambda *a,**k:io.BytesIO(json.dumps({'id':1,'error':{'code':-32603,'data':'tx already exists in cache'}}).encode())
            result=gateway.execute(request)
            self.assertEqual(result['error']['data'],'tx already exists in cache')
            self.assertNotIn('result',result)
            self.assertEqual(gateway.execute(self.request('status',{}))['error']['code'],-32000)
        with patch('sfera_mesh.consensus_directory._http_opener') as opener:
            opener.return_value.open.return_value=io.BytesIO(json.dumps({'id':1,'error':{'code':-32603,'data':'other failure'}}).encode())
            self.assertEqual(gateway.execute(request)['error']['code'],-32000)


if __name__=='__main__':unittest.main()
