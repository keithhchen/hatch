#!/usr/bin/env python3
"""
VERIFICATION TOOL ONLY. A raw TCP WebSocket consumer that stops reading. Node clients cannot shrink their socket receive buffer,
so the kernel swallows megabytes before the server's own buffer limit is ever reached; this client sets SO_RCVBUF to 4 KB before
connecting, handshakes, subscribes, then reads nothing for STALL_SECONDS. It then reads everything that reached it and reports
how many JSON frames arrived, the highest cursor, and the close code, as one JSON line on stdout.

env: HOST PORT PATH HELLO_JSON SUBSCRIBE_JSON STALL_SECONDS [RELEASE_ON_STDIN=1: stop stalling as soon as a line arrives on stdin]
HELLO_JSON is the first message of the system under test (Studio: auth; Chat Runtime: client.hello); the first reply is awaited before subscribing.
The output says how the connection ended: "close" (close frame), "eof" (the server dropped the TCP connection), "timeout" (still open).
"""
import base64, json, os, select, socket, struct, sys, time

host, port, path = os.environ["HOST"], int(os.environ["PORT"]), os.environ["PATH_"]
hello, subscribe = os.environ["HELLO_JSON"], os.environ["SUBSCRIBE_JSON"]
stall = float(os.environ.get("STALL_SECONDS", "8"))

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
sock.connect((host, port))
key = base64.b64encode(os.urandom(16)).decode()
sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
head = b""
while b"\r\n\r\n" not in head:
    head += sock.recv(1)
if b" 101 " not in head.split(b"\r\n")[0]:
    print(json.dumps({"error": head.decode(errors="replace")[:200]})); sys.exit(0)


def frame(text):
    payload = text.encode()
    mask = os.urandom(4)
    n = len(payload)
    header = bytes([0x81]) + (bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n))
    return header + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(payload))


def read_exact(count):
    data = b""
    while len(data) < count:
        chunk = sock.recv(count - len(data))
        if not chunk:
            raise EOFError
        data += chunk
    return data


def read_frame():
    b1, b2 = read_exact(2)
    n = b2 & 0x7F
    if n == 126:
        n = struct.unpack(">H", read_exact(2))[0]
    elif n == 127:
        n = struct.unpack(">Q", read_exact(8))[0]
    return b1 & 0x0F, read_exact(n)


# The first server frame (ready) may arrive after the hello; send it, wait for the reply, then subscribe, then stop reading.
sock.sendall(frame(hello))
sock.settimeout(10)
opcode, payload = read_frame()
sock.sendall(frame(subscribe))
if os.environ.get("RELEASE_ON_STDIN"):
    select.select([sys.stdin], [], [], stall)
else:
    time.sleep(stall)

frames, last_cursor, close_code, ended = 0, None, None, "timeout"
sock.settimeout(5)
try:
    while True:
        opcode, payload = read_frame()
        if opcode == 8:
            ended = "close"
            close_code = struct.unpack(">H", payload[:2])[0] if len(payload) >= 2 else None
            break
        if opcode == 1:
            frames += 1
            try:
                message = json.loads(payload)
                if message.get("cursor") is not None:
                    last_cursor = message["cursor"]
            except ValueError:
                pass
except (EOFError, ConnectionResetError):
    ended = "eof"
except socket.timeout:
    pass
print(json.dumps({"frames": frames, "last_cursor": last_cursor, "close_code": close_code, "ended": ended}))
