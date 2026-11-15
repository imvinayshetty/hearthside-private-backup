import base64
import json
from pathlib import Path
import tempfile
import unittest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization
from service import Store, canonical, private_ip

class PairingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.now = 1000
        self.drive = Path(self.temp.name) / 'drive'
        self.drive.mkdir()
        self.store = Store(Path(self.temp.name) / 'state', self.drive, lambda: self.now)
        self.store.register('a@example.com', 'Vinay')
        self.key = Ed25519PrivateKey.generate()
        self.public = base64.b64encode(self.key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()
    def tearDown(self):
        self.store.db.close()
        self.temp.cleanup()
    def sign(self, value, key=None):
        return base64.b64encode((key or self.key).sign(canonical(value))).decode()
    def begin(self, code=None, device='blue_pixel_device_123'):
        ticket = self.store.mint('a@example.com', 'Blue Pixel') if code is None else None
        value = dict(email='a@example.com', code=code or ticket['code'], deviceId=device, publicKey=self.public)
        value['signature'] = self.sign(value)
        return self.store.begin(value, '192.168.1.2'), value
    def confirm(self, offer, key=None):
        value = {k: offer[k] for k in ('requestId','challenge','profile','phone')}
        return self.store.confirm({'requestId':offer['requestId'], 'signature':self.sign(value, key)})
    def test_complete_signed_enrollment(self):
        offer,_ = self.begin()
        self.assertEqual(self.confirm(offer), {'connected': True, 'email':'a@example.com','profile':'Vinay','phone':'Blue Pixel'})
        self.assertTrue((self.drive/'HomeSafeBckup/Vinay/Blue Pixel').is_dir())
    def test_code_single_use(self):
        _,value = self.begin()
        with self.assertRaisesRegex(ValueError, 'already used'): self.store.begin(value, '192.168.1.2')
    def test_expiry_120_seconds(self):
        ticket = self.store.mint('a@example.com','Blue Pixel')
        self.now += 121
        with self.assertRaisesRegex(ValueError, 'expired'): self.begin(ticket['code'])
    def test_confirm_single_use(self):
        offer,_ = self.begin(); self.confirm(offer)
        with self.assertRaisesRegex(ValueError, 'already used'): self.confirm(offer)
    def test_confirmation_expires_60_seconds(self):
        offer,_ = self.begin(); self.now += 61
        with self.assertRaisesRegex(ValueError, 'expired'): self.confirm(offer)
    def test_wrong_private_key_rejected(self):
        offer,_ = self.begin()
        with self.assertRaises(Exception): self.confirm(offer, Ed25519PrivateKey.generate())
        self.assertFalse((self.drive/'HomeSafeBckup/Vinay/Blue Pixel').exists())
    def test_five_attempt_limit(self):
        ticket = self.store.mint('a@example.com','Blue Pixel')
        wrong = '000000' if ticket['code'] != '000000' else '000001'
        for _ in range(5):
            with self.assertRaises(ValueError): self.begin(wrong)
        with self.assertRaisesRegex(ValueError, '60 seconds'): self.begin(ticket['code'])
    def test_duplicate_phone_rejected_case_insensitively(self):
        offer,_ = self.begin(); self.confirm(offer)
        with self.assertRaisesRegex(ValueError, 'already exists'): self.store.mint('a@example.com','blue pixel')
    def test_existing_folder_never_overwritten(self):
        offer,_ = self.begin()
        folder = self.drive/'HomeSafeBckup/Vinay/Blue Pixel'; folder.mkdir(parents=True)
        (folder/'keep.txt').write_text('keep')
        with self.assertRaisesRegex(ValueError, 'overwritten'): self.confirm(offer)
        self.assertEqual((folder/'keep.txt').read_text(), 'keep')
    def test_catalog_isolation_replay_and_revocation(self):
        offer,_ = self.begin(); self.confirm(offer)
        folder = self.drive/'HomeSafeBckup/Vinay/Blue Pixel/Full_Bckup_151126'; folder.mkdir()
        (folder/'manifest.json').write_text(json.dumps(dict(files=2,bytes=15,complete=True)))
        other = self.drive/'HomeSafeBckup/Other/Other Phone/Full_Bckup_151126'; other.mkdir(parents=True)
        (other/'manifest.json').write_text(json.dumps(dict(files=999,bytes=999,complete=True)))
        device = 'blue_pixel_device_123'
        challenge = self.store.challenge({'deviceId':device})['challenge']
        value = dict(deviceId=device,challenge=challenge,action='catalog')
        request = dict(deviceId=device,challenge=challenge,signature=self.sign(value))
        rows = self.store.catalog(request)['backups']
        self.assertEqual(len(rows),1); self.assertEqual(rows[0]['files'],2)
        with self.assertRaises(ValueError): self.store.catalog(request)
        self.store.revoke(device)
        with self.assertRaisesRegex(ValueError,'revoked'): self.store.challenge({'deviceId':device})
    def test_profile_isolation(self):
        with self.assertRaisesRegex(ValueError,'already registered'): self.store.register('b@example.com','vinay')
    def test_symlink_escape_rejected(self):
        offer,_ = self.begin()
        root = self.drive/'HomeSafeBckup'; root.symlink_to(Path(self.temp.name),target_is_directory=True)
        with self.assertRaisesRegex(ValueError,'Unsafe'): self.confirm(offer)
    def test_bind_private_network_only(self):
        self.assertTrue(private_ip('192.168.1.2')); self.assertTrue(private_ip('10.0.0.1'))
        self.assertFalse(private_ip('127.0.0.1')); self.assertFalse(private_ip('8.8.8.8'))

if __name__ == '__main__': unittest.main()
