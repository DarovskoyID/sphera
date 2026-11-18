"""Loopback-only TCP partition harness. Never used by mesh runtime."""
import select
import socket
import socketserver
import threading


class _Relay(socketserver.BaseRequestHandler):
    def handle(self):
        owner = self.server.owner
        if owner.blocked.is_set():
            return
        try:
            with socket.create_connection(owner.upstream, timeout=1) as upstream:
                self.request.settimeout(1)
                sockets = (self.request, upstream)
                while not owner.blocked.is_set() and not owner.stopped.is_set():
                    readable, _, _ = select.select(sockets, [], [], .05)
                    for source in readable:
                        data = source.recv(65536)
                        if not data:
                            return
                        if source is self.request and owner.requests_dropped.is_set():
                            continue
                        if source is upstream and owner.responses_dropped.is_set():
                            continue
                        destination = upstream if source is self.request else self.request
                        destination.sendall(data)
        except OSError:
            return  # A cut is a transport failure, never a fabricated response.


class _Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    block_on_close = False


class LabPartitionProxy:
    def __init__(self, upstream):
        if not isinstance(upstream, tuple) or len(upstream) != 2 or upstream[0] != '127.0.0.1' or type(upstream[1]) is not int or not 1 <= upstream[1] <= 65535:
            raise ValueError('loopback_upstream_required')
        self.upstream = upstream
        self.blocked, self.stopped = threading.Event(), threading.Event()
        self.requests_dropped, self.responses_dropped = threading.Event(), threading.Event()
        self.server = _Server(('127.0.0.1', 0), _Relay)
        self.server.owner = self
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=.05), daemon=True)
        self.thread.start()

    @property
    def endpoint(self):
        return f'http://127.0.0.1:{self.server.server_address[1]}'

    def cut(self):
        self.blocked.set()

    def heal(self):
        self.blocked.clear()
        self.requests_dropped.clear()
        self.responses_dropped.clear()

    def drop_requests(self):
        """Discard client bytes while keeping TCP and the reverse path open."""
        self.requests_dropped.set()

    def drop_responses(self):
        """Deliver requests, silently discard upstream bytes; no fake response."""
        self.responses_dropped.set()

    def close(self):
        self.stopped.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)
