"""The receiving end of cross-machine sync: what we hold for a source.

A host that keeps its memory here still has its transcripts on its own disk, and
no server can reach that disk. This is the other half: the host asks what we
already have for a source, and sends only the bytes past that point.

Two properties decide the shape:

* **The server's copy is the only truth.** There is no local queue on the host
  and no local state file, so the manifest we return *is* the resume state. A
  host that loses its state loses nothing: it asks again and continues.
* **Appending is validated, not trusted.** A host may have truncated, replaced,
  or diverged on a file while we were unreachable. `tail_hash` names the bytes
  we are about to extend; if they do not match, the answer is `409` and the host
  re-reads the manifest on its next pass rather than writing into a file it no
  longer agrees with.

Files live under `<data_dir>/received/<source_id>/<relative path>` and are only
ever appended to. The importer reads that tree the same way it reads any other
source root, so nothing downstream needs to know these files arrived over a
socket instead of being on this disk.
"""

import base64
import binascii
import hashlib
import os
import stat
from pathlib import Path, PurePosixPath

from pydantic import BaseModel, ConfigDict, Field

#: How many trailing bytes `tail_hash` covers. Big enough that a truncated or
#: rewritten tail is caught, small enough that hashing every file in a manifest
#: is one read of the last block rather than the whole file.
TAIL_BYTES = 4096
#: The hash of a file we do not hold. A host that has never sent this path
#: starts from zero and must quote exactly this, so "the file is new" and "the
#: file was replaced by an empty one" cannot be confused.
EMPTY_TAIL = hashlib.sha256(b"").hexdigest()
#: One append carries at most this much. Transcripts append in kilobyte-sized
#: batches; a cap this generous still bounds a single request's memory.
MAX_APPEND_BYTES = 4 * 1024 * 1024
MAX_PATH_CHARS = 4096
MAX_SEGMENT_CHARS = 255


class ReceivedFile(BaseModel):
    """One file the server holds for a source, as the host sees it."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    path: str
    size: int
    tail_hash: str


class SyncConflict(RuntimeError):
    """The bytes we hold are not the bytes the host is extending."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def _safe_relative(raw: str) -> PurePosixPath:
    """A path from a host, reduced to something that cannot leave the root.

    Host paths are POSIX-shaped on purpose even when the host is Windows: the
    host is describing a path *inside a source root*, and letting it send a
    drive letter or a backslash would make the same file two names here. `..`,
    absolute paths, and control characters are refused rather than normalised --
    a host that sends one is confused or hostile, and silently repairing either
    case hides it.
    """
    if not isinstance(raw, str) or not raw or len(raw) > MAX_PATH_CHARS:
        raise ValueError("sync_path_invalid")
    if any(character in raw for character in ("\0", "\r", "\n", "\\")):
        raise ValueError("sync_path_invalid")
    if raw.startswith("/"):
        raise ValueError("sync_path_invalid")
    parts = raw.split("/")
    for part in parts:
        if part in ("", ".", "..") or len(part) > MAX_SEGMENT_CHARS:
            raise ValueError("sync_path_invalid")
        # A colon would smuggle in a drive letter or an NTFS alternate data
        # stream, either of which names a file this store does not own.
        if ":" in part:
            raise ValueError("sync_path_invalid")
        # A leading dot would collide with the store's own bookkeeping and with
        # the importer's habit of ignoring dotfiles.
        if part.startswith("."):
            raise ValueError("sync_path_invalid")
    return PurePosixPath(*parts)


def _tail_hash(handle: int, size: int) -> str:
    start = max(0, size - TAIL_BYTES)
    digest = hashlib.sha256()
    remaining = size - start
    os.lseek(handle, start, os.SEEK_SET)
    while remaining > 0:
        chunk = os.read(handle, min(remaining, 64 * 1024))
        if not chunk:
            raise SyncConflict("sync_store_short_read")
        digest.update(chunk)
        remaining -= len(chunk)
    return digest.hexdigest()


class ReceivedFileStore:
    """Append-only storage for the files a host has sent us."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def source_root(self, source_id: str) -> Path:
        return self.root / source_id

    def _resolve(self, source_id: str, relative: PurePosixPath) -> Path:
        base = self.source_root(source_id)
        target = base.joinpath(*relative.parts)
        # Segments are already validated, so this cannot escape by name; it can
        # still escape through a symlink that is already on disk.
        if not target.resolve(strict=False).is_relative_to(base.resolve(strict=False)):
            raise ValueError("sync_path_invalid")
        return target

    def manifest(self, source_id: str) -> tuple[ReceivedFile, ...]:
        base = self.source_root(source_id)
        if not base.is_dir():
            return ()
        files: list[ReceivedFile] = []
        for current, directories, names in os.walk(base, followlinks=False):
            directories[:] = sorted(name for name in directories if not name.startswith("."))
            for name in sorted(names):
                if name.startswith("."):
                    continue
                full = Path(current) / name
                try:
                    info = full.lstat()
                except OSError:
                    continue
                if not stat.S_ISREG(info.st_mode):
                    continue
                relative = full.relative_to(base).as_posix()
                handle = os.open(full, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                try:
                    digest = _tail_hash(handle, info.st_size)
                finally:
                    os.close(handle)
                files.append(ReceivedFile(path=relative, size=info.st_size, tail_hash=digest))
        return tuple(files)

    def append(
        self,
        source_id: str,
        path: str,
        *,
        offset: int,
        tail_hash: str,
        data: bytes,
    ) -> ReceivedFile:
        relative = _safe_relative(path)
        if offset < 0:
            raise ValueError("sync_offset_invalid")
        if len(data) > MAX_APPEND_BYTES:
            raise ValueError("sync_append_too_large")
        if len(tail_hash) != 64 or any(c not in "0123456789abcdef" for c in tail_hash):
            raise ValueError("sync_tail_hash_invalid")

        base = self.source_root(source_id)
        target = self._resolve(source_id, relative)
        base.mkdir(parents=True, exist_ok=True, mode=0o700)
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)

        existing = target.lstat() if target.exists() else None
        if existing is not None and not stat.S_ISREG(existing.st_mode):
            raise ValueError("sync_path_invalid")

        if existing is None:
            if offset != 0:
                raise SyncConflict("sync_offset_mismatch")
            current_tail = EMPTY_TAIL
            size = 0
        else:
            size = existing.st_size
            if offset != size:
                raise SyncConflict("sync_offset_mismatch")
            handle = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                current_tail = _tail_hash(handle, size)
            finally:
                os.close(handle)
        if current_tail != tail_hash:
            raise SyncConflict("sync_tail_mismatch")

        flags = os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
        handle = os.open(target, flags | os.O_APPEND, 0o600)
        try:
            written = 0
            while written < len(data):
                written += os.write(handle, data[written:])
            os.fsync(handle)
        finally:
            os.close(handle)
        # Read the tail back through a second handle: the one above is
        # `O_WRONLY` and cannot be read, and the tail has to describe what is
        # actually on disk rather than what we believe we wrote.
        reader = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            size = os.fstat(reader).st_size
            new_tail = _tail_hash(reader, size)
        finally:
            os.close(reader)
        _sync_directory(target.parent)
        return ReceivedFile(path=relative.as_posix(), size=size, tail_hash=new_tail)


def _sync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


class SyncAppendRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=MAX_PATH_CHARS)
    #: Where the host wants to start writing. Must equal what we hold.
    offset: int = Field(ge=0)
    #: sha256 of the last `TAIL_BYTES` bytes we are about to extend.
    tail_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    #: The new bytes, base64. Transcripts append in small batches; the cap in
    #: `MAX_APPEND_BYTES` bounds a single request.
    data: str

    def payload(self) -> bytes:
        try:
            return base64.b64decode(self.data, validate=True)
        except (binascii.Error, ValueError):
            raise ValueError("sync_data_invalid") from None


class SyncManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = 1
    source_id: str
    files: tuple[ReceivedFile, ...]
