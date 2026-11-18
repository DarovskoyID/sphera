from types import SimpleNamespace
import unittest
from unittest.mock import patch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .identity import node_id
from .public_transport import DiscoveredHttpsTransport


class DiscoveredTransportTests(unittest.TestCase):
    def setUp(self):
        self.public=Ed25519PrivateKey.generate().public_key().public_bytes_raw();self.identity=node_id(self.public);self.original='https://original.example:8443'
        self.transport=DiscoveredHttpsTransport({self.identity:self.original},SimpleNamespace(endpoint_policy='https-v1'),{self.identity:self.public})

    def test_routes_rotate_without_changing_identity_or_bootstrap_context(self):
        self.transport.validate(self.original,self.identity)
        for endpoint in ('https://new.example:9443','https://another.example:9443'):
            with patch('sfera_mesh.discovery.discovered_peers',return_value={'peers':{self.identity:{'public_key':self.public.hex(),'endpoint':endpoint}}}):
                route,_=self.transport.route(self.original,self.identity,'probe');self.assertEqual(route,endpoint+'/mesh/v1/probe')

    def test_no_fallback_on_expired_unknown_or_substituted_peer(self):
        for peers in ({},{self.identity:{'public_key':'a'*64,'endpoint':'https://new.example:8443'}}):
            with patch('sfera_mesh.discovery.discovered_peers',return_value={'peers':peers}):
                with self.assertRaises(ValueError):self.transport.route(self.original,self.identity,'probe')
        with patch('sfera_mesh.discovery.discovered_peers',side_effect=ValueError('expired_anchor')):
            with self.assertRaisesRegex(ValueError,'expired_anchor'):self.transport.route(self.original,self.identity,'probe')


if __name__=='__main__':unittest.main()
