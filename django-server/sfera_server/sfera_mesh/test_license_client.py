from hashlib import sha256
import json
import time
import unittest
from unittest.mock import patch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from .identity import node_id
from .storage import canonical
from .license_client import request_attestation
from sfera_modules.commercial import CommercialError


class LicenseClientTests(unittest.TestCase):
    def test_operator_bridge_signs_binding_and_verifies_response(self):
        node = Ed25519PrivateKey.generate()
        issuer = Ed25519PrivateKey.generate()
        public = issuer.public_key().public_bytes_raw()
        issuer_id = sha256(public).hexdigest()
        instance = '12345678-1234-4234-8234-123456789012'
        current = int(time.time())
        claims = {'schema': 'sfera-mesh-license-v1', 'issuer': issuer_id, 'instance_id': instance, 'node_id': node_id(node.public_key().public_bytes_raw()), 'network': 'test', 'issued_at': current, 'expires_at': current + 300, 'modules': []}
        document = {'claims': claims, 'signature': issuer.sign(canonical(claims)).hex()}
        with patch('sfera_mesh.license_client.config', return_value=('https://issuer.test', instance, 'private-test-credential')), patch('sfera_mesh.license_client.build_opener') as opener:
            response = opener.return_value.open.return_value.__enter__.return_value
            response.headers.get_content_type.return_value = 'application/json'
            response.read.return_value = json.dumps(document).encode()
            received, verified = request_attestation(node, 'test', {issuer_id: public})
            self.assertEqual(received, document)
            self.assertEqual(verified.modules, frozenset())
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, 'https://issuer.test/v1/mesh/attestation')
            sent = json.loads(request.data)
            proof = bytes.fromhex(sent.pop('proof'))
            node.public_key().verify(proof, canonical({'domain': 'sfera-mesh-license-binding-v1', **sent}))
            self.assertNotIn('private-test-credential', request.data.decode())
            # A server cannot cause automatic adoption of a different issuer.
            with self.assertRaises(CommercialError): request_attestation(node, 'test', {})
            response.read.return_value = b'x' * 16385
            with self.assertRaises(CommercialError): request_attestation(node, 'test', {issuer_id: public})
