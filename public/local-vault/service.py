"""HomeSafe LAN pairing service. Run only on the trusted Vault computer."""
import socket
import argparse
import base64
import datetime as dt
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.x509.oid import NameOID


def segment(value):
    if not isinstance(value, str):
        raise ValueError('Invalid folder name')
    name = value.strip()
    if not name or len(name) > 80 or re.search(r'[\\/<>:"|?*\x00-\x1f]', name) or name.endswith(('.', ' ')) or re.match(r'^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)', name, re.I):
        raise ValueError('Invalid folder name')
    return name


def email(value):
    if not isinstance(value, str) or len(value) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', value.strip()):
        raise ValueError('Invalid account email')
    return value.strip().lower()


def private_ip(value):
    ip = ipaddress.IPv4Address(value)
    return any(ip in ipaddress.IPv4Network(net) for net in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'))


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()


def verify(key, signature, message):
    ed25519.Ed25519PublicKey.from_public_bytes(base64.b64decode(key, validate=True)).verify(base64.b64decode(signature, validate=True), canonical(message))


class Store:
    def __init__(self, directory, drive, clock=time.time):
        self.directory, self.drive, self.clock = Path(directory), Path(drive).resolve(), clock
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.directory, 0o700)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.directory / 'pairing.sqlite', check_same_thread=False)
        os.chmod(self.directory / 'pairing.sqlite', 0o600)
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS accounts(email TEXT PRIMARY KEY, profile TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY, email TEXT, phone TEXT, digest TEXT, expires REAL, attempts INTEGER DEFAULT 0, used INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, email TEXT, phone TEXT, key TEXT, revoked INTEGER DEFAULT 0, UNIQUE(email, phone));
        CREATE TABLE IF NOT EXISTS pending(id TEXT PRIMARY KEY, ticket TEXT UNIQUE, device TEXT, key TEXT, challenge TEXT, expires REAL);
        CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, device TEXT, expires REAL);
        CREATE TABLE IF NOT EXISTS limits(peer TEXT PRIMARY KEY, failures INTEGER, until REAL);
        CREATE TABLE IF NOT EXISTS transfers(id TEXT PRIMARY KEY, device TEXT, folder TEXT, digest TEXT, files TEXT, done TEXT, state TEXT);
        ''')
        self.db.commit()

    def register(self, account, profile):
        account, profile = email(account), segment(profile)
        with self.lock:
            old = self.db.execute('SELECT profile FROM accounts WHERE email=?', (account,)).fetchone()
            if old and old[0] != profile:
                raise ValueError('Account already registered to a different profile')
            for other in self.db.execute('SELECT email,profile FROM accounts'):
                if other[1].casefold() == profile.casefold() and other[0] != account:
                    raise ValueError('Profile already registered')
            self.db.execute('INSERT OR IGNORE INTO accounts VALUES (?,?)', (account, profile))
            self.db.commit()

    def mint(self, account, phone):
        account, phone = email(account), segment(phone)
        if re.match(r'^(Full|Custom)_Bckup_', phone, re.I):
            raise ValueError('Phone names cannot be dated backup names')
        with self.lock:
            row = self.db.execute('SELECT profile FROM accounts WHERE email=?', (account,)).fetchone()
            if not row:
                raise ValueError('Register on your Vault first')
            existing = self.db.execute('SELECT phone FROM devices WHERE email=?', (account,)).fetchall()
            folder = self.drive / 'HomeSafeBckup' / row[0]
            if any(p[0].casefold() == phone.casefold() for p in existing) or (folder.exists() and any(p.name.casefold() == phone.casefold() for p in folder.iterdir())):
                raise ValueError('Phone already exists; reconnect instead')
            self.db.execute('UPDATE tickets SET used=1 WHERE email=? AND phone=?', (account, phone))
            ident, code = secrets.token_urlsafe(24), f'{secrets.randbelow(1000000):06d}'
            expires = self.clock() + 120
            self.db.execute('INSERT INTO tickets(id,email,phone,digest,expires) VALUES (?,?,?,?,?)', (ident, account, phone, hashlib.sha256((ident + code).encode()).hexdigest(), expires))
            self.db.commit()
            return {'ticket': ident, 'code': code, 'expiresAt': expires}

    def begin(self, data, peer):
        account = email(data['email'])
        key, device, code = data['publicKey'], data['deviceId'], data['code']
        if not isinstance(device, str) or not re.fullmatch(r'[a-zA-Z0-9_-]{16,128}', device) or not re.fullmatch(r'\d{6}', code):
            raise ValueError('Invalid pairing request')
        verify(key, data['signature'], {k: data[k] for k in ('email', 'code', 'deviceId', 'publicKey')})
        with self.lock:
            now = self.clock()
            limit = self.db.execute('SELECT failures,until FROM limits WHERE peer=?', (peer,)).fetchone()
            if limit and limit[1] > now:
                raise ValueError('Too many attempts. Wait 60 seconds')
            rows = self.db.execute('SELECT id,phone,digest,expires,attempts FROM tickets WHERE email=? AND used=0 ORDER BY expires DESC', (account,)).fetchall()
            match = next((r for r in rows if r[3] > now and r[4] < 5 and secrets.compare_digest(r[2], hashlib.sha256((r[0] + code).encode()).hexdigest())), None)
            if not match:
                failures = (limit[0] if limit and limit[1] == 0 else 0) + 1
                self.db.execute('INSERT OR REPLACE INTO limits VALUES (?,?,?)', (peer, failures, now + 60 if failures >= 5 else 0))
                self.db.execute('UPDATE tickets SET attempts=attempts+1 WHERE email=? AND used=0', (account,))
                self.db.commit()
                raise ValueError('Invalid, expired or already used pairing code')
            if self.db.execute('SELECT 1 FROM devices WHERE id=?', (device,)).fetchone():
                raise ValueError('Device already enrolled; reconnect instead')
            # Claim a ticket only once. A signed confirmation must follow.
            request, challenge = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            self.db.execute('UPDATE tickets SET used=1 WHERE id=?', (match[0],))
            self.db.execute('INSERT INTO pending VALUES (?,?,?,?,?,?)', (request, match[0], device, key, challenge, min(match[3], now + 60)))
            self.db.commit()
            profile = self.db.execute('SELECT profile FROM accounts WHERE email=?', (account,)).fetchone()[0]
            return {'requestId': request, 'challenge': challenge, 'expiresAt': min(match[3], now + 60), 'email': account, 'profile': profile, 'phone': match[1]}

    def confirm(self, data):
        with self.lock:
            row = self.db.execute('SELECT p.ticket,p.device,p.key,p.challenge,p.expires,t.email,t.phone,a.profile FROM pending p JOIN tickets t ON p.ticket=t.id JOIN accounts a ON t.email=a.email WHERE p.id=?', (data['requestId'],)).fetchone()
            if not row or row[4] <= self.clock():
                raise ValueError('Pairing confirmation expired or already used')
            verify(row[2], data['signature'], {'requestId': data['requestId'], 'challenge': row[3], 'profile': row[7], 'phone': row[6]})
            if not self.drive.is_dir():
                raise ValueError('Backup drive disconnected')
            root = self.drive / 'HomeSafeBckup'
            profile = root / segment(row[7])
            phone = profile / segment(row[6])
            for folder in (root, profile, phone):
                if folder.is_symlink() or not folder.resolve().is_relative_to(self.drive):
                    raise ValueError('Unsafe storage destination')
            profile.mkdir(parents=True, exist_ok=True)
            if any(p.name.casefold() == phone.name.casefold() for p in profile.iterdir()):
                raise ValueError('Phone folder already exists; nothing overwritten')
            phone.mkdir(mode=0o700)
            self.db.execute('INSERT INTO devices(id,email,phone,key) VALUES (?,?,?,?)', (row[1], row[5], row[6], row[2]))
            self.db.execute('DELETE FROM pending WHERE id=?', (data['requestId'],))
            self.db.commit()
            return {'connected': True, 'email': row[5], 'profile': row[7], 'phone': row[6]}

    def challenge(self, data):
        with self.lock:
            device = self.db.execute('SELECT 1 FROM devices WHERE id=? AND revoked=0', (data['deviceId'],)).fetchone()
            if not device:
                raise ValueError('Device unavailable or revoked')
            self.db.execute('DELETE FROM challenges WHERE expires<=?', (self.clock(),))
            self.db.execute('DELETE FROM challenges WHERE device=?', (data['deviceId'],))
            nonce = secrets.token_urlsafe(32)
            self.db.execute('INSERT INTO challenges VALUES (?,?,?)', (nonce, data['deviceId'], self.clock() + 30))
            self.db.commit()
            return {'challenge': nonce, 'expiresAt': self.clock() + 30}

    def catalog(self, data):
        with self.lock:
            row = self.db.execute('SELECT d.email,d.phone,d.key,a.profile FROM devices d JOIN accounts a ON a.email=d.email WHERE d.id=? AND d.revoked=0', (data['deviceId'],)).fetchone()
            nonce = self.db.execute('SELECT expires FROM challenges WHERE id=? AND device=?', (data['challenge'], data['deviceId'])).fetchone()
            if not row or not nonce or nonce[0] <= self.clock():
                raise ValueError('Device proof missing, expired or revoked')
            verify(row[2], data['signature'], {'deviceId': data['deviceId'], 'challenge': data['challenge'], 'action': 'catalog'})
            self.db.execute('DELETE FROM challenges WHERE id=?', (data['challenge'],))
            self.db.commit()
            folder = self.drive / 'HomeSafeBckup' / row[3] / row[1]
            if not folder.is_dir() or any(p.is_symlink() for p in (folder, folder.parent, folder.parent.parent)):
                raise ValueError('Drive disconnected or unsafe phone folder')
            backups = []
            for path in folder.iterdir():
                match = re.fullmatch(r'(Full|Custom)_Bckup_(\d{6})(?:_.+)?', path.name)
                if not match or not path.is_dir() or path.is_symlink():
                    continue
                manifest = path / 'manifest.json'
                if manifest.is_symlink() or manifest.stat().st_size > 1048576:
                    raise ValueError('Unreadable backup manifest')
                entry = json.loads(manifest.read_text())
                date = dt.datetime.strptime(match[2], '%d%m%y').date().isoformat()
                if any(not isinstance(entry.get(k), int) or isinstance(entry.get(k), bool) or entry[k] < 0 for k in ('files', 'bytes')) or not isinstance(entry.get('complete'), bool):
                    raise ValueError('Invalid backup manifest')
                backups.append({'name': path.name, 'kind': match[1], 'date': date, 'files': entry['files'], 'bytes': entry['bytes'], 'complete': entry['complete']})
            return {'backups': backups}

    def _device(self, device):
        row = self.db.execute('SELECT d.email,d.phone,d.key,a.profile FROM devices d JOIN accounts a ON a.email=d.email WHERE d.id=? AND d.revoked=0', (device,)).fetchone()
        if not row:
            raise ValueError('Device unavailable or revoked')
        return row

    def _proof(self, data, action, extra):
        row = self._device(data['deviceId'])
        nonce = self.db.execute('SELECT expires FROM challenges WHERE id=? AND device=?', (data['challenge'], data['deviceId'])).fetchone()
        if not nonce or nonce[0] <= self.clock():
            raise ValueError('Device proof missing or expired')
        verify(row[2], data['signature'], {'deviceId': data['deviceId'], 'challenge': data['challenge'], 'action': action, **extra})
        self.db.execute('DELETE FROM challenges WHERE id=?', (data['challenge'],))
        return row

    def _phone_folder(self, row):
        if not self.drive.is_dir():
            raise ValueError('Backup drive disconnected')
        folder = self.drive / 'HomeSafeBckup' / row[3] / row[1]
        if not folder.is_dir() or any(p.is_symlink() for p in (folder, folder.parent, folder.parent.parent)) or not folder.resolve().is_relative_to(self.drive):
            raise ValueError('Drive disconnected or unsafe phone folder')
        return folder

    def start_backup(self, data):
        name, kind, files = segment(data['name']), data['kind'], data['files']
        if kind not in ('Full', 'Custom') or not isinstance(files, list) or not 0 < len(files) <= 100000:
            raise ValueError('Invalid backup request')
        today = dt.datetime.fromtimestamp(self.clock()).strftime('%d%m%y')
        base = f'{kind}_Bckup_{today}'
        if name != base and not name.startswith(base + '_'):
            raise ValueError(f'Backup name must start with {base}')
        clean, seen, total = [], set(), 0
        for item in files:
            path, size = item.get('path') if isinstance(item, dict) else None, item.get('bytes') if isinstance(item, dict) else None
            if not isinstance(path, str) or not isinstance(size, int) or isinstance(size, bool) or size < 0 or len(path) > 1024:
                raise ValueError('Invalid file entry')
            parts = [segment(p) for p in path.split('/')]
            if len(parts) > 32 or parts[-1].endswith('.homesafe-part') or parts[-1] == 'manifest.json' and len(parts) == 1:
                raise ValueError('Invalid file path')
            key = '/'.join(parts).casefold()
            if key in seen:
                raise ValueError('Duplicate file path')
            seen.add(key); clean.append(['/'.join(parts), size]); total += size
        with self.lock:
            row = self._proof(data, 'backup', {'name': name, 'kind': kind, 'files': len(clean), 'bytes': total})
            folder = self._phone_folder(row)
            existing = [p.name for p in folder.iterdir()]
            if any(n.casefold() == name.casefold() for n in existing):
                raise ValueError('That backup already exists. Existing files will not be overwritten.')
            if name == base and any(re.fullmatch(rf'(Full|Custom)_Bckup_{today}(_.+)?', n) for n in existing):
                raise ValueError('A backup already exists for today. Add a unique suffix.')
            target = folder / name
            target.mkdir(mode=0o700)
            (target / 'manifest.json').write_text(json.dumps({'kind': kind, 'files': len(clean), 'bytes': total, 'complete': False}))
            ident, token = secrets.token_urlsafe(24), secrets.token_urlsafe(32)
            self.db.execute('INSERT INTO transfers VALUES (?,?,?,?,?,?,?)', (ident, data['deviceId'], str(target), hashlib.sha256(token.encode()).hexdigest(), json.dumps(clean), '[]', 'running'))
            self.db.commit()
            return {'transferId': ident, 'token': token}

    def _transfer(self, ident, token):
        row = self.db.execute('SELECT device,folder,digest,files,done,state FROM transfers WHERE id=?', (ident,)).fetchone()
        if not row or not isinstance(token, str) or not secrets.compare_digest(row[2], hashlib.sha256(token.encode()).hexdigest()) or row[5] != 'running':
            raise ValueError('Transfer unavailable')
        self._device(row[0])
        folder = Path(row[1])
        if not folder.is_dir() or folder.is_symlink() or not folder.resolve().is_relative_to(self.drive):
            raise ValueError('Backup drive disconnected')
        return folder, json.loads(row[3]), json.loads(row[4])

    def chunk(self, ident, token, index, offset, digest, body):
        with self.lock:
            folder, files, done = self._transfer(ident, token)
            if not isinstance(index, int) or not 0 <= index < len(files) or index in done:
                raise ValueError('Invalid file index')
            if hashlib.sha256(body).hexdigest() != digest:
                raise ValueError('Chunk checksum mismatch')
            path, size = files[index]
            final = folder.joinpath(*path.split('/'))
            part = final.with_name(final.name + '.homesafe-part')
            final.parent.mkdir(parents=True, exist_ok=True)
            if not final.parent.resolve().is_relative_to(folder.resolve()) or final.exists() or part.is_symlink():
                raise ValueError('Unsafe destination; nothing overwritten')
            current = part.stat().st_size if part.exists() else 0
            if offset != current or current + len(body) > size:
                raise ValueError('Unexpected chunk offset')
            with open(part, 'ab') as handle:
                handle.write(body)
            if current + len(body) == size:
                os.link(part, final); part.unlink()
                done.append(index)
                self.db.execute('UPDATE transfers SET done=? WHERE id=?', (json.dumps(done), ident))
                self.db.commit()
            return {'received': current + len(body)}

    def finish(self, data):
        with self.lock:
            folder, files, done = self._transfer(data['transferId'], data['token'])
            if len(done) != len(files):
                raise ValueError('Some files were not received')
            total = sum(f[1] for f in files)
            manifest = json.loads((folder / 'manifest.json').read_text())
            manifest['complete'] = True
            tmp = folder / 'manifest.json.homesafe-part'
            tmp.write_text(json.dumps(manifest)); os.replace(tmp, folder / 'manifest.json')
            self.db.execute("UPDATE transfers SET state='complete' WHERE id=?", (data['transferId'],))
            self.db.commit()
            return {'state': 'complete', 'sentBytes': total, 'totalBytes': total}

    def revoke(self, device):
        with self.lock:
            self.db.execute('UPDATE devices SET revoked=1 WHERE id=?', (device,))
            self.db.commit()


def certificate(directory, host):
    directory = Path(directory)
    cert, keyfile = directory / 'vault.pem', directory / 'vault-key.pem'
    if not cert.exists() and not keyfile.exists():
        # ECDSA P-256: Ed25519 TLS certificates are not accepted by iOS or Android.
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'HomeSafe local Vault')])
        now = dt.datetime.now(dt.timezone.utc)
        value = x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(minutes=1)).not_valid_after(now + dt.timedelta(days=365)).add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address(host))]), critical=False).sign(key, hashes.SHA256())
        keyfile.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
        os.chmod(keyfile, 0o600)
        cert.write_bytes(value.public_bytes(serialization.Encoding.PEM))
    value = x509.load_pem_x509_certificate(cert.read_bytes())
    if x509.IPAddress(ipaddress.ip_address(host)) not in value.extensions.get_extension_for_class(x509.SubjectAlternativeName).value:
        raise ValueError('Certificate address changed; explicitly rotate certificate and re-pair')
    return cert, keyfile, value.fingerprint(hashes.SHA256()).hex()


def server(store, host, port):
    if not private_ip(host):
        raise ValueError('Bind only to a private home-network IPv4 address')
    cert, key, fingerprint = certificate(store.directory, host)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # Never log pairing codes, identities or signatures.
        def do_POST(self):
            try:
                if not private_ip(self.client_address[0]) or self.headers.get('Origin') or self.headers.get('Transfer-Encoding'):
                    raise ValueError('Native home-network connections only')
                size = int(self.headers.get('Content-Length', '0'))
                if self.path == '/v1/backup/chunk':
                    if size < 0 or size > 4194304:
                        raise ValueError('Invalid chunk size')
                    h = self.headers
                    output, status = store.chunk(h.get('X-Transfer-Id'), h.get('X-Transfer-Token'), int(h.get('X-File-Index', '-1')), int(h.get('X-Offset', '-1')), h.get('X-Sha256', ''), self.rfile.read(size)), 200
                else:
                    limit = 16777216 if self.path == '/v1/backup/start' else 8192
                    if size < 2 or size > limit:
                        raise ValueError('Invalid request size')
                    data = json.loads(self.rfile.read(size))
                    if not isinstance(data, dict):
                        raise ValueError('Invalid request')
                    actions = {'/v1/pair/begin': lambda: store.begin(data, self.client_address[0]), '/v1/pair/confirm': lambda: store.confirm(data), '/v1/device/challenge': lambda: store.challenge(data), '/v1/backups': lambda: store.catalog(data), '/v1/backup/start': lambda: store.start_backup(data), '/v1/backup/finish': lambda: store.finish(data)}
                    action = actions.get(self.path)
                    if not action:
                        self.send_error(404); return
                    output, status = action(), 200
            except ValueError as error:
                output, status = {'error': str(error)}, 403
            except Exception:
                output, status = {'error': 'Request rejected. Check the code, expiry, device identity and drive on your Vault.'}, 403
            payload = canonical(output)
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
    class Server(ThreadingHTTPServer):
        daemon_threads = True
        def get_request(self):
            sock, addr = super().get_request()
            sock.settimeout(30)
            return sock, addr
    http = Server((host, port), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(cert, key)
    http.socket = context.wrap_socket(http.socket, server_side=True)
    return http, fingerprint


def advertise(host, port, fingerprint):
    """Announces the Vault on home Wi-Fi (_homesafe._tcp) so phones only need the code. Optional: needs zeroconf."""
    try:
        from zeroconf import ServiceInfo, Zeroconf
    except ImportError:
        print('Wi-Fi discovery off (pip install zeroconf). Phones can still pair with the QR code.')
        return None
    zc = Zeroconf(interfaces=[host])
    info = ServiceInfo('_homesafe._tcp.local.', 'HomeSafe Vault._homesafe._tcp.local.', addresses=[socket.inet_aton(host)], port=port, properties={'v': '1', 'fp': fingerprint})
    zc.register_service(info)
    return zc


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', default=str(Path.home() / '.homesafe-vault'))
    parser.add_argument('--drive', required=True)
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, default=7443)
    args = parser.parse_args()
    store = Store(args.state, args.drive)
    http, fingerprint = server(store, args.host, args.port)
    threading.Thread(target=http.serve_forever, daemon=True).start()
    advert = advertise(args.host, args.port, fingerprint)
    print(f'Local Vault: https://{args.host}:{args.port}\nSHA-256: {fingerprint}')
    print('Trusted local console commands: register EMAIL PROFILE | pair EMAIL PHONE | revoke DEVICE_ID | quit')
    try:
        while True:
            line = input('vault> ').split(' ', 2)
            try:
                if line[0] == 'quit': break
                if line[0] == 'register' and len(line) == 3: store.register(line[1], line[2]); print('Registered locally.')
                elif line[0] == 'pair' and len(line) == 3:
                    offer = store.mint(line[1], line[2])
                    print(json.dumps({'version': 1, 'address': f'https://{args.host}:{args.port}', 'fingerprint': fingerprint, **offer}))
                elif line[0] == 'revoke' and len(line) == 2: store.revoke(line[1]); print('Revoked.')
                else: print('Unknown command')
            except (ValueError, IndexError) as error: print(str(error))
    except (EOFError, KeyboardInterrupt): pass
    finally: http.shutdown(); store.db.close()

if __name__ == '__main__':
    main()
