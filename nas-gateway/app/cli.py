import argparse
import os
import secrets
import sys

from app.config import BASE_PATH, DATABASE_PATH
from app.filesystem import DIRECTORY_FLAGS, _open_dir_chain, path_parts
from app.store import ProductStore


def validate_root(nas_root: str) -> str:
    parts = path_parts(nas_root, allow_empty=False)
    base_fd = os.open(BASE_PATH, DIRECTORY_FLAGS)
    try:
        root_fd = _open_dir_chain(base_fd, parts)
    finally:
        os.close(base_fd)
    os.close(root_fd)
    return "/".join(parts)


def main() -> None:
    parser = argparse.ArgumentParser(prog="nas-gateway-admin")
    parser.add_argument("--database", default=DATABASE_PATH)
    commands = parser.add_subparsers(dest="command", required=True)

    add = commands.add_parser("add-product")
    add.add_argument("--product-id", required=True)
    add.add_argument("--nas-root", required=True)

    rotate = commands.add_parser("rotate-key")
    rotate.add_argument("--product-id", required=True)

    enable = commands.add_parser("set-enabled")
    enable.add_argument("--product-id", required=True)
    enable.add_argument("--enabled", choices=("true", "false"), required=True)

    commands.add_parser("list-products")
    args = parser.parse_args()
    store = ProductStore(args.database)

    if args.command == "add-product":
        nas_root = validate_root(args.nas_root)
        key = secrets.token_urlsafe(48)
        store.add(args.product_id, key, nas_root)
        sys.stdout.write(f"product_id={args.product_id}\nkey={key}\n")
        return
    if args.command == "rotate-key":
        sys.stdout.write(f"key={store.rotate_key(args.product_id)}\n")
        return
    if args.command == "set-enabled":
        store.set_enabled(args.product_id, args.enabled == "true")
        sys.stdout.write(f"product_id={args.product_id} enabled={args.enabled}\n")
        return
    for product in store.list_products():
        sys.stdout.write(
            f"product_id={product['product_id']} nas_root={product['nas_root']} enabled={str(product['enabled']).lower()}\n"
        )


if __name__ == "__main__":
    main()
