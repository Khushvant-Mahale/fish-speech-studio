import socket
import struct

_orig_getaddrinfo = socket.getaddrinfo

def _query_dns(domain: str) -> str:
    packet = b'\xaa\xbb\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00'
    for part in domain.split('.'):
        packet += struct.pack('!B', len(part)) + part.encode('ascii', errors='ignore')
    packet += b'\x00\x00\x01\x00\x01'
    for dns in ('8.8.8.8', '1.1.1.1'):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(2.0)
            s.sendto(packet, (dns, 53))
            data, _ = s.recvfrom(1024)
            s.close()
            idx = 12
            while data[idx] != 0:
                idx += data[idx] + 1
            idx += 5
            while idx < len(data):
                if data[idx] & 0xc0 == 0xc0:
                    idx += 2
                else:
                    while data[idx] != 0:
                        idx += data[idx] + 1
                    idx += 1
                atype, aclass, ttl, rdlen = struct.unpack('!HHIH', data[idx:idx+10])
                idx += 10
                if atype == 1 and rdlen == 4:
                    return socket.inet_ntoa(data[idx:idx+4])
                idx += rdlen
        except Exception:
            pass
    return None

def _resilient_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    try:
        return _orig_getaddrinfo(host, port, family, type, proto, flags)
    except socket.gaierror:
        if isinstance(host, str) and not host.replace('.', '').isdigit():
            ip = _query_dns(host)
            if ip:
                return _orig_getaddrinfo(ip, port, family, type, proto, flags)
        raise

def setup_resilient_dns():
    """Installs resilient DNS fallback resolver to bypass disconnected VPN/TAP virtual network adapters."""
    socket.getaddrinfo = _resilient_getaddrinfo
