import os
import re
import secrets
import sqlite3
from dataclasses import dataclass

from app.config import DATABASE_PATH
from app.errors import GatewayError

PRODUCT_ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}\Z")


@dataclass(frozen=True)
class Product:
    product_id: str
    key: str
    nas_root: str
    enabled: bool


class ProductStore:
    def __init__(self, database_path: str = DATABASE_PATH):
        self.database_path = database_path
        os.makedirs(os.path.dirname(database_path), mode=0o700, exist_ok=True)
        os.chmod(os.path.dirname(database_path), 0o700)
        with self.connect() as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(
                """CREATE TABLE IF NOT EXISTS product_nas_access (
                    product_id TEXT PRIMARY KEY,
                    key TEXT NOT NULL UNIQUE,
                    nas_root TEXT NOT NULL,
                    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
                )"""
            )
        os.chmod(database_path, 0o600)

    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    def find_key(self, key: str) -> Product:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT product_id, key, nas_root, enabled FROM product_nas_access WHERE key = ?",
                (key,),
            ).fetchone()
        if row is None or not row["enabled"]:
            raise GatewayError(401, "INVALID_CREDENTIALS", "Bearer key is invalid or disabled")
        return Product(row["product_id"], row["key"], row["nas_root"], True)

    def add(self, product_id: str, key: str, nas_root: str) -> None:
        if not PRODUCT_ID_PATTERN.fullmatch(product_id):
            raise ValueError("product_id must use lowercase letters, digits, hyphens, or underscores")
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO product_nas_access (product_id, key, nas_root, enabled) VALUES (?, ?, ?, 1)",
                (product_id, key, nas_root),
            )

    def rotate_key(self, product_id: str) -> str:
        key = secrets.token_urlsafe(48)
        with self.connect() as connection:
            result = connection.execute(
                "UPDATE product_nas_access SET key = ? WHERE product_id = ?",
                (key, product_id),
            )
            if result.rowcount != 1:
                raise ValueError(f"unknown product_id: {product_id}")
        return key

    def set_enabled(self, product_id: str, enabled: bool) -> None:
        with self.connect() as connection:
            result = connection.execute(
                "UPDATE product_nas_access SET enabled = ? WHERE product_id = ?",
                (int(enabled), product_id),
            )
            if result.rowcount != 1:
                raise ValueError(f"unknown product_id: {product_id}")

    def list_products(self) -> list[dict[str, str | bool]]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT product_id, nas_root, enabled FROM product_nas_access ORDER BY product_id"
            ).fetchall()
        return [
            {"product_id": row["product_id"], "nas_root": row["nas_root"], "enabled": bool(row["enabled"])}
            for row in rows
        ]
