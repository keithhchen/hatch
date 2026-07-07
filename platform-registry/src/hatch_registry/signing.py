from __future__ import annotations

import base64
import hashlib
import json
from dataclasses import dataclass

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from hatch_registry.models import AppManifest, ManifestSignature


DEV_KEY_ID = "hatch-dev-ed25519-2026-01"


def canonical_manifest_bytes(manifest: AppManifest) -> bytes:
    payload = manifest.model_dump(mode="json", exclude_none=True)
    return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


@dataclass(frozen=True)
class ManifestSigner:
    private_key: Ed25519PrivateKey
    key_id: str = DEV_KEY_ID

    @classmethod
    def development(cls) -> "ManifestSigner":
        seed = hashlib.sha256(b"hatch-registry-mvp-development-signing-key").digest()
        return cls(private_key=Ed25519PrivateKey.from_private_bytes(seed))

    def sign(self, manifest: AppManifest) -> ManifestSignature:
        payload = canonical_manifest_bytes(manifest)
        signature = self.private_key.sign(payload)
        public_key = self.private_key.public_key().public_bytes(
            encoding=Encoding.Raw,
            format=PublicFormat.Raw,
        )
        return ManifestSignature(
            algorithm="ed25519",
            key_id=self.key_id,
            public_key=_b64(public_key),
            signature=_b64(signature),
        )
