import base64
import datetime as dt
import errno
import fnmatch
import os
import re
import stat
from contextlib import contextmanager
from typing import Iterator

from app.config import (
    BASE_PATH,
    FIND_MAX_ENTRIES,
    FIND_MAX_RESULTS,
    GREP_MAX_BYTES,
    GREP_MAX_FILES,
    GREP_MAX_RESULTS,
    MAX_READ_BYTES,
    READDIR_MAX_ENTRIES,
)
from app.errors import GatewayError
from app.store import Product

DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK


def path_parts(path: str, *, allow_empty: bool = True) -> list[str]:
    if not isinstance(path, str) or "\x00" in path:
        raise GatewayError(400, "INVALID_PATH", "Path must be a POSIX path string")
    # Every path is inside the product's root, so a leading "/" names that root ("/facts" is "facts").
    parts = path.lstrip("/").split("/")
    if any(part == ".." for part in parts):
        raise GatewayError(403, "PATH_OUTSIDE_ROOT", "Parent path segments are not allowed")
    normalized = [part for part in parts if part not in ("", ".")]
    if not allow_empty and not normalized:
        raise GatewayError(400, "PATH_REQUIRED", "A file or directory path is required")
    return normalized


def _open_dir_chain(start_fd: int, parts: list[str]) -> int:
    current_fd = os.dup(start_fd)
    try:
        for part in parts:
            next_fd = os.open(part, DIRECTORY_FLAGS, dir_fd=current_fd)
            os.close(current_fd)
            current_fd = next_fd
        return current_fd
    except OSError as error:
        os.close(current_fd)
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise GatewayError(403, "PATH_OUTSIDE_ROOT", "Symbolic links and non-directory path segments are not allowed") from error
        if error.errno == errno.ENOENT:
            raise GatewayError(404, "PATH_NOT_FOUND", "Requested path does not exist") from error
        raise


@contextmanager
def product_root(product: Product) -> Iterator[int]:
    base_fd = os.open(BASE_PATH, DIRECTORY_FLAGS)
    try:
        product_fd = _open_dir_chain(base_fd, path_parts(product.nas_root, allow_empty=False))
    finally:
        os.close(base_fd)
    try:
        yield product_fd
    finally:
        os.close(product_fd)


@contextmanager
def directory_fd(root_fd: int, path: str) -> Iterator[int]:
    fd = _open_dir_chain(root_fd, path_parts(path))
    try:
        yield fd
    finally:
        os.close(fd)


def _entry_type(mode: int) -> str:
    if stat.S_ISREG(mode):
        return "file"
    if stat.S_ISDIR(mode):
        return "directory"
    if stat.S_ISLNK(mode):
        return "symlink"
    return "other"


def _stat_at(parent_fd: int, name: str) -> os.stat_result:
    try:
        result = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError as error:
        raise GatewayError(404, "PATH_NOT_FOUND", "Requested path does not exist") from error
    if stat.S_ISLNK(result.st_mode):
        raise GatewayError(403, "PATH_OUTSIDE_ROOT", "Symbolic links are not allowed")
    return result



def _stat_payload(path: str, result: os.stat_result) -> dict[str, object]:
    return {
        "path": path,
        "type": _entry_type(result.st_mode),
        "device": result.st_dev,
        "rdev": result.st_rdev,
        "inode": result.st_ino,
        "mode": result.st_mode,
        "links": result.st_nlink,
        "uid": result.st_uid,
        "gid": result.st_gid,
        "size": result.st_size,
        "atime_ns": result.st_atime_ns,
        "mtime_ns": result.st_mtime_ns,
        "ctime_ns": result.st_ctime_ns,
        "block_size": result.st_blksize,
        "blocks": result.st_blocks,
    }


def _open_target(root_fd: int, path: str, *, allow_directory: bool = False) -> tuple[int, str, os.stat_result]:
    parts = path_parts(path, allow_empty=allow_directory)
    if not parts:
        if not allow_directory:
            raise GatewayError(400, "PATH_REQUIRED", "A file path is required")
        fd = os.dup(root_fd)
        result = os.fstat(fd)
        return fd, "", result
    parent_fd = _open_dir_chain(root_fd, parts[:-1])
    try:
        result = _stat_at(parent_fd, parts[-1])
        if stat.S_ISDIR(result.st_mode):
            fd = os.open(parts[-1], DIRECTORY_FLAGS, dir_fd=parent_fd)
        else:
            fd = os.open(parts[-1], FILE_FLAGS, dir_fd=parent_fd)
        return fd, "/".join(parts), result
    except OSError as error:
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise GatewayError(403, "PATH_OUTSIDE_ROOT", "Symbolic links and non-directory path segments are not allowed") from error
        if error.errno == errno.ENOENT:
            raise GatewayError(404, "PATH_NOT_FOUND", "Requested path does not exist") from error
        raise
    finally:
        os.close(parent_fd)


def readdir(product: Product, path: str) -> dict[str, object]:
    with product_root(product) as root_fd, directory_fd(root_fd, path) as fd:
        entries = []
        truncated = False
        with os.scandir(fd) as iterator:
            for entry in iterator:
                if len(entries) == READDIR_MAX_ENTRIES:
                    truncated = True
                    break
                result = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                entries.append({"name": entry.name, "type": _entry_type(result.st_mode)})
        entries.sort(key=lambda item: str(item["name"]).casefold())
        return {"path": "/".join(path_parts(path)), "entries": entries, "truncated": truncated}


def stat_path(product: Product, path: str) -> dict[str, object]:
    parts = path_parts(path)
    with product_root(product) as root_fd:
        if not parts:
            return _stat_payload("", os.fstat(root_fd))
        parent_fd = _open_dir_chain(root_fd, parts[:-1])
        try:
            result = _stat_at(parent_fd, parts[-1])
            return _stat_payload("/".join(parts), result)
        finally:
            os.close(parent_fd)


def _open_target_with_stat(product: Product, path: str, *, allow_directory: bool) -> tuple[int, str, os.stat_result]:
    with product_root(product) as root_fd:
        fd, normalized, _ = _open_target(root_fd, path, allow_directory=allow_directory)
        return fd, normalized, os.fstat(fd)


def read_file(product: Product, path: str, offset: int, length: int) -> dict[str, object]:
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise GatewayError(400, "INVALID_OFFSET", "offset must be a non-negative integer")
    if isinstance(length, bool) or not isinstance(length, int) or length < 0:
        raise GatewayError(400, "INVALID_LENGTH", "length must be a non-negative integer")
    if length > MAX_READ_BYTES:
        raise GatewayError(413, "READ_LIMIT_EXCEEDED", "Requested length exceeds the configured read limit")
    fd, normalized, result = _open_target_with_stat(product, path, allow_directory=False)
    try:
        if not stat.S_ISREG(result.st_mode):
            raise GatewayError(400, "NOT_A_FILE", "Requested path is not a regular file")
        raw = os.pread(fd, length, offset)
    finally:
        os.close(fd)
    try:
        content_fields = {"content": raw.decode("utf-8", errors="strict"), "encoding": "utf-8"}
    except UnicodeDecodeError:
        content_fields = {"content_base64": base64.b64encode(raw).decode("ascii"), "encoding": "base64"}
    return {"path": normalized, "offset": offset, "bytes_read": len(raw), **content_fields}


def _scan_entries(
    fd: int,
    relative: str,
    scanned: list[int],
    *,
    recursive: bool = True,
) -> Iterator[tuple[str, os.stat_result]]:
    names = []
    with os.scandir(fd) as iterator:
        for entry in iterator:
            scanned[0] += 1
            if scanned[0] > FIND_MAX_ENTRIES:
                raise GatewayError(413, "SEARCH_LIMIT_EXCEEDED", "Directory scan exceeded the configured entry limit")
            names.append(entry.name)
    for name in sorted(names, key=str.casefold):
        result = os.stat(name, dir_fd=fd, follow_symlinks=False)
        entry_path = f"{relative}/{name}" if relative else name
        yield entry_path, result
        if recursive and stat.S_ISDIR(result.st_mode):
            child_fd = os.open(name, DIRECTORY_FLAGS, dir_fd=fd)
            try:
                yield from _scan_entries(child_fd, entry_path, scanned, recursive=True)
            finally:
                os.close(child_fd)


TYPE_ALIASES = {"dir": "directory", "d": "directory", "folder": "directory", "f": "file", "l": "symlink", "link": "symlink", "all": "any", "*": "any"}


def find_files(product: Product, path: str, name_pattern: str, item_type: str) -> dict[str, object]:
    if not isinstance(name_pattern, str) or not name_pattern or len(name_pattern) > 256:
        raise GatewayError(400, "INVALID_NAME_PATTERN", "name_pattern must contain between 1 and 256 characters")
    if isinstance(item_type, str):
        item_type = TYPE_ALIASES.get(item_type.strip().lower(), item_type.strip().lower())
    if not isinstance(item_type, str) or item_type not in {"file", "directory", "symlink", "other", "any"}:
        raise GatewayError(400, "INVALID_TYPE", "type must be file, directory, symlink, other, or any")
    matches = []
    scanned = [0]
    truncated = False
    with product_root(product) as root_fd, directory_fd(root_fd, path) as start_fd:
        for relative, result in _scan_entries(start_fd, "/".join(path_parts(path)), scanned):
            kind = _entry_type(result.st_mode)
            if fnmatch.fnmatchcase(os.path.basename(relative), name_pattern) and (item_type == "any" or item_type == kind):
                if len(matches) == FIND_MAX_RESULTS:
                    truncated = True
                    break
                matches.append(relative)
    return {"matches": matches, "scanned_entries": scanned[0], "truncated": truncated}


def grep_files(
    product: Product,
    path: str,
    pattern: str,
    recursive: bool,
    glob: str,
    case_sensitive: bool,
    max_results: int,
) -> dict[str, object]:
    if not isinstance(pattern, str) or not pattern or len(pattern) > 4096:
        raise GatewayError(400, "INVALID_PATTERN", "pattern must contain between 1 and 4096 characters")
    if not isinstance(glob, str) or not glob or len(glob) > 256:
        raise GatewayError(400, "INVALID_GLOB", "glob must contain between 1 and 256 characters")
    if not isinstance(recursive, bool) or not isinstance(case_sensitive, bool):
        raise GatewayError(400, "INVALID_PARAMETER", "recursive and case_sensitive must be booleans")
    if isinstance(max_results, bool) or not isinstance(max_results, int) or max_results <= 0:
        raise GatewayError(400, "INVALID_MAX_RESULTS", "max_results must be a positive integer")
    if max_results > GREP_MAX_RESULTS:
        raise GatewayError(413, "SEARCH_LIMIT_EXCEEDED", "max_results exceeds the configured result limit")
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        search_pattern = re.compile(pattern, flags)
    except re.error as error:
        raise GatewayError(400, "INVALID_PATTERN", f"Invalid Python re pattern: {error}") from error
    scanned_files = 0
    scanned_bytes = 0
    skipped_non_text_files = 0
    matches = []
    truncated = False
    start_parts = path_parts(path)
    with product_root(product) as root_fd:
        start_fd, normalized, start_stat = _open_target(root_fd, path, allow_directory=True)
        try:
            if stat.S_ISDIR(start_stat.st_mode):
                candidates = _scan_entries(
                    start_fd,
                    normalized,
                    [0],
                    recursive=recursive,
                )
            elif stat.S_ISREG(start_stat.st_mode):
                candidates = iter(((normalized, start_stat),))
            else:
                raise GatewayError(400, "NOT_A_FILE", "Requested path is not a regular file or directory")
            for relative, result in candidates:
                if stat.S_ISDIR(result.st_mode) or not stat.S_ISREG(result.st_mode):
                    continue
                if not fnmatch.fnmatchcase(os.path.basename(relative), glob):
                    continue
                scanned_files += 1
                if scanned_files > GREP_MAX_FILES:
                    raise GatewayError(413, "SEARCH_LIMIT_EXCEEDED", "grep exceeded the configured file scan limit")
                fd, _, opened_stat = _open_target(root_fd, relative, allow_directory=False)
                try:
                    if not stat.S_ISREG(opened_stat.st_mode):
                        continue
                    remaining = GREP_MAX_BYTES - scanned_bytes
                    if remaining <= 0 or opened_stat.st_size > remaining:
                        raise GatewayError(413, "SEARCH_LIMIT_EXCEEDED", "grep exceeded the configured byte scan limit")
                    raw = os.pread(fd, opened_stat.st_size, 0)
                finally:
                    os.close(fd)
                scanned_bytes += len(raw)
                if b"\x00" in raw:
                    skipped_non_text_files += 1
                    continue
                try:
                    text = raw.decode("utf-8", errors="strict")
                except UnicodeDecodeError:
                    skipped_non_text_files += 1
                    continue
                lines = text.split("\n") if text else []
                if text.endswith("\n"):
                    lines.pop()
                for line_number, line in enumerate(lines, start=1):
                    if search_pattern.search(line):
                        if len(matches) == max_results:
                            truncated = True
                            break
                        matches.append({"path": relative, "line": line_number, "text": line})
                if truncated:
                    break
        finally:
            os.close(start_fd)
    return {
        "matches": matches,
        "scanned_files": scanned_files,
        "scanned_bytes": scanned_bytes,
        "skipped_non_text_files": skipped_non_text_files,
        "truncated": truncated,
    }


HINT_MAX_ENTRIES = 5000
HINT_MAX_DEPTH = 3
HINT_MAX_SUGGESTIONS = 5


def _path_hint(product: Product, path: str) -> str:
    """Where the asked-for name really is, and what the root holds, so the next call can be right."""
    try:
        wanted = path_parts(path)
    except GatewayError:
        return ""
    if not wanted:
        return ""
    name = wanted[-1]
    suggestions: list[str] = []
    top: list[str] = []
    try:
        with product_root(product) as root_fd:
            with os.scandir(root_fd) as iterator:
                for entry in iterator:
                    kind = _entry_type(os.stat(entry.name, dir_fd=root_fd, follow_symlinks=False).st_mode)
                    top.append(entry.name + ("/" if kind == "directory" else ""))
            scanned = 0

            def walk(fd: int, relative: str, depth: int) -> None:
                nonlocal scanned
                with os.scandir(fd) as iterator:
                    names = [entry.name for entry in iterator]
                for child in sorted(names, key=str.casefold):
                    scanned += 1
                    if scanned > HINT_MAX_ENTRIES or len(suggestions) >= HINT_MAX_SUGGESTIONS:
                        return
                    child_path = f"{relative}/{child}" if relative else child
                    mode = os.stat(child, dir_fd=fd, follow_symlinks=False).st_mode
                    if child.casefold() == name.casefold():
                        suggestions.append(child_path)
                    if stat.S_ISDIR(mode) and depth < HINT_MAX_DEPTH:
                        child_fd = os.open(child, DIRECTORY_FLAGS, dir_fd=fd)
                        try:
                            walk(child_fd, child_path, depth + 1)
                        finally:
                            os.close(child_fd)

            walk(root_fd, "", 1)
    except (GatewayError, OSError):
        return ""
    parts = ["Paths are relative to the knowledge root."]
    if suggestions:
        parts.append("Did you mean: " + ", ".join(suggestions) + "?")
    if top:
        parts.append("The root holds: " + ", ".join(sorted(top, key=str.casefold)[:30]) + ".")
    return " ".join(parts)


def with_path_hints(operation):
    """Wraps a filesystem operation: a path that does not exist comes back with where to look instead."""
    def wrapped(product: Product, path: str, *args, **kwargs):
        try:
            return operation(product, path, *args, **kwargs)
        except GatewayError as error:
            if error.code != "PATH_NOT_FOUND":
                raise
            hint = _path_hint(product, path)
            raise GatewayError(error.status_code, error.code, f"Requested path does not exist: {path!r}. {hint}".strip()) from error
    wrapped.__name__ = operation.__name__
    return wrapped


readdir = with_path_hints(readdir)
stat_path = with_path_hints(stat_path)
read_file = with_path_hints(read_file)
find_files = with_path_hints(find_files)
grep_files = with_path_hints(grep_files)
