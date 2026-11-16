import os


def required_path(name: str) -> str:
    value = os.environ[name]
    if not value.startswith("/"):
        raise ValueError(f"{name} must be an absolute path")
    return value


def positive_integer(name: str) -> int:
    value = int(os.environ[name])
    if value <= 0:
        raise ValueError(f"{name} must be a positive integer")
    return value


BASE_PATH = required_path("NAS_GATEWAY_BASE")
DATABASE_PATH = required_path("NAS_GATEWAY_DB")
MAX_READ_BYTES = positive_integer("NAS_GATEWAY_MAX_READ_BYTES")
READDIR_MAX_ENTRIES = positive_integer("NAS_GATEWAY_READDIR_MAX_ENTRIES")
FIND_MAX_RESULTS = positive_integer("NAS_GATEWAY_FIND_MAX_RESULTS")
FIND_MAX_ENTRIES = positive_integer("NAS_GATEWAY_FIND_MAX_ENTRIES")
GREP_MAX_RESULTS = positive_integer("NAS_GATEWAY_GREP_MAX_RESULTS")
GREP_MAX_FILES = positive_integer("NAS_GATEWAY_GREP_MAX_FILES")
GREP_MAX_BYTES = positive_integer("NAS_GATEWAY_GREP_MAX_BYTES")
MCP_ALLOWED_HOSTS = tuple(
    item.strip()
    for item in os.environ["NAS_GATEWAY_MCP_ALLOWED_HOSTS"].split(",")
    if item.strip()
)
if not MCP_ALLOWED_HOSTS:
    raise ValueError("NAS_GATEWAY_MCP_ALLOWED_HOSTS must contain at least one host")
