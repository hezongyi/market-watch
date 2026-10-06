"""Acceptance-only TLS: a server leaf signed by a separate private CA."""

import os
import subprocess
from pathlib import Path

import certifi


def create_tls(root):
    root = Path(root)

    def run(*command):
        subprocess.run(command, check=True, capture_output=True)

    run(
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        str(root / "ca-key.pem"),
        "-out",
        str(root / "ca.pem"),
        "-days",
        "7",
        "-subj",
        "/CN=Market Watch isolated acceptance CA",
        "-addext",
        "basicConstraints=critical,CA:TRUE",
        "-addext",
        "keyUsage=critical,keyCertSign,cRLSign",
    )
    run(
        "openssl",
        "req",
        "-new",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        str(root / "key.pem"),
        "-out",
        str(root / "server.csr"),
        "-subj",
        "/CN=localhost",
    )
    (root / "server.ext").write_text(
        "basicConstraints=critical,CA:FALSE\n"
        "keyUsage=critical,digitalSignature,keyEncipherment\n"
        "extendedKeyUsage=serverAuth\n"
        "subjectAltName=DNS:localhost,IP:127.0.0.1\n"
    )
    run(
        "openssl",
        "x509",
        "-req",
        "-in",
        str(root / "server.csr"),
        "-CA",
        str(root / "ca.pem"),
        "-CAkey",
        str(root / "ca-key.pem"),
        "-CAcreateserial",
        "-out",
        str(root / "cert.pem"),
        "-days",
        "7",
        "-extfile",
        str(root / "server.ext"),
    )
    (root / "ca-bundle.pem").write_text(
        Path(certifi.where()).read_text() + (root / "ca.pem").read_text()
    )
    for name in (
        "ca-key.pem",
        "ca.pem",
        "key.pem",
        "cert.pem",
        "ca-bundle.pem",
        "server.csr",
        "server.ext",
        "ca.srl",
    ):
        os.chmod(root / name, 0o600)
