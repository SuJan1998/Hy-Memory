"""Appending a host's files into a source's own authorised root.

Two things are worth pinning here and they are different failures:

* the manifest is the only resume state, so it has to be derived from the files
  rather than remembered;
* an append is validated against the bytes we hold, because a host may have
  rewritten its copy while we were unreachable and appending to a file the two
  sides disagree about produces a transcript that parses as nothing.

The store takes the root from the caller rather than owning one. That is the
whole point of the shape: what arrives is written where the importer already
looks, so a sync cannot "succeed" into a directory nothing reads.
"""

import base64
import hashlib

import pytest
from fastapi.testclient import TestClient

from one_memory.api import create_app
from one_memory.config import Settings
from one_memory.imports.sources.registry import RootCandidateKind, build_source_catalog
from one_memory.sync_files import (
    EMPTY_TAIL,
    MAX_APPEND_BYTES,
    ReceivedFileStore,
    SyncConflict,
)

TOKEN = "sync-token"


def tail(data: bytes, size: int = 4096) -> str:
    return hashlib.sha256(data[max(0, len(data) - size) :]).hexdigest()


@pytest.fixture()
def store():
    return ReceivedFileStore()


@pytest.fixture()
def root(tmp_path):
    directory = tmp_path / "root"
    directory.mkdir()
    return directory


def append(store, root, path, data, *, offset=0, tail_hash=EMPTY_TAIL):
    return store.append(root, path, offset=offset, tail_hash=tail_hash, data=data)


def test_manifest_of_an_empty_root_is_empty(store, root):
    assert store.manifest(root) == ()


def test_manifest_of_a_root_that_does_not_exist_is_empty(store, tmp_path):
    assert store.manifest(tmp_path / "missing") == ()


def test_append_creates_the_file_and_reports_what_it_holds(store, root):
    record = append(store, root, "sessions/a.jsonl", b'{"id":1}\n')

    assert record.path == "sessions/a.jsonl"
    assert record.size == 9
    assert record.tail_hash == tail(b'{"id":1}\n')
    assert store.manifest(root) == (record,)
    # Written into the granted root itself, not a side tree.
    assert (root / "sessions/a.jsonl").read_bytes() == b'{"id":1}\n'


def test_append_continues_from_the_offset_the_manifest_reported(store, root):
    first = append(store, root, "sessions/a.jsonl", b'{"id":1}\n')
    second = append(
        store,
        root,
        "sessions/a.jsonl",
        b'{"id":2}\n',
        offset=first.size,
        tail_hash=first.tail_hash,
    )

    assert second.size == 18
    assert (root / "sessions/a.jsonl").read_bytes() == b'{"id":1}\n{"id":2}\n'


def test_a_stale_offset_is_refused_rather_than_appended(store, root):
    first = append(store, root, "sessions/a.jsonl", b'{"id":1}\n')

    with pytest.raises(SyncConflict) as raised:
        append(store, root, "sessions/a.jsonl", b'{"id":2}\n', offset=0, tail_hash=EMPTY_TAIL)
    assert raised.value.code == "sync_offset_mismatch"
    # The file must be untouched: a refused append that wrote anyway would
    # corrupt the transcript for the next pass too.
    assert (root / "sessions/a.jsonl").read_bytes() == b'{"id":1}\n'
    assert first.size == 9


def test_a_tail_that_does_not_match_is_refused(store, root):
    first = append(store, root, "sessions/a.jsonl", b'{"id":1}\n')
    wrong = tail(b"something else entirely")

    with pytest.raises(SyncConflict) as raised:
        append(store, root, "sessions/a.jsonl", b'{"id":2}\n', offset=first.size, tail_hash=wrong)
    assert raised.value.code == "sync_tail_mismatch"


def test_tail_hash_covers_only_the_last_window(store, root):
    long_record = b"x" * 9000
    first = append(store, root, "sessions/big.jsonl", long_record)

    assert first.tail_hash == hashlib.sha256(long_record[-4096:]).hexdigest()
    assert first.tail_hash != hashlib.sha256(long_record).hexdigest()


def test_the_manifest_sees_every_file_and_no_directories(store, root):
    append(store, root, "a/one.jsonl", b"1\n")
    append(store, root, "a/two.jsonl", b"2\n")
    append(store, root, "b/three.jsonl", b"3\n")

    assert [item.path for item in store.manifest(root)] == [
        "a/one.jsonl",
        "a/two.jsonl",
        "b/three.jsonl",
    ]


@pytest.mark.parametrize(
    "path",
    [
        "",
        "/etc/passwd",
        "../escape.jsonl",
        "a/../../escape.jsonl",
        "a//b.jsonl",
        "./a.jsonl",
        "a/./b.jsonl",
        "a\\b.jsonl",
        "C:/windows.jsonl",
        "a/\x00b.jsonl",
        "a/\nb.jsonl",
        ".hidden.jsonl",
        "a/.hidden.jsonl",
    ],
)
def test_a_path_that_could_leave_the_root_is_refused(store, root, path):
    with pytest.raises(ValueError):
        append(store, root, path, b"x")


def test_a_path_that_traverses_through_a_symlink_is_refused(store, root, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    (root / "link").symlink_to(outside, target_is_directory=True)

    with pytest.raises(ValueError):
        append(store, root, "link/escape.jsonl", b"x")
    assert list(outside.iterdir()) == []


def test_an_append_larger_than_the_cap_is_refused(store, root):
    with pytest.raises(ValueError):
        append(store, root, "big.jsonl", b"x" * (MAX_APPEND_BYTES + 1))


def test_a_malformed_tail_hash_is_refused(store, root):
    with pytest.raises(ValueError):
        append(store, root, "a.jsonl", b"x", tail_hash="not-a-hash")


def test_two_roots_are_separate(store, tmp_path):
    first = tmp_path / "first"
    second = tmp_path / "second"
    append(store, first, "a.jsonl", b"one\n")
    append(store, second, "a.jsonl", b"two\n")

    assert [item.path for item in store.manifest(first)] == ["a.jsonl"]
    assert (first / "a.jsonl").read_bytes() == b"one\n"
    assert (second / "a.jsonl").read_bytes() == b"two\n"


def test_a_directory_sitting_where_a_file_belongs_is_refused(store, root):
    (root / "a.jsonl").mkdir()

    with pytest.raises(ValueError):
        append(store, root, "a.jsonl", b"x")


class _App:
    """A Core with one known source, so the routes can be exercised."""

    def __init__(self, tmp_path):
        home = tmp_path / "home"
        self.root = tmp_path / "root"
        # The source has to exist locally before a host may push files for it.
        self.root.mkdir(parents=True, exist_ok=True)
        self.app = create_app(
            Settings(
                _env_file=None,
                data_dir=tmp_path,
                source_home=home,
                api_token=TOKEN,
                # Disabling imports empties the source catalog, and an unknown
                # source is a 404 before any of the sync logic is reached.
                imports_enabled=True,
                automatic_memory_processing=False,
                live_sync_enabled=False,
            ),
            source_catalog={"codex": build_source_catalog(home=home, environment={})["codex"]},
        )

    def __enter__(self):
        self.client = TestClient(self.app, headers={"Authorization": f"Bearer {TOKEN}"})
        self.client.__enter__()
        return self

    def __exit__(self, *exception):
        return self.client.__exit__(*exception)

    def grant(self):
        self.app.state.source_grant_store.grant(
            user_id="local",
            source_id="codex",
            root=self.root,
            candidate_kind=RootCandidateKind.DEFAULT,
        )


def test_an_unknown_source_is_not_a_sync_target(tmp_path):
    with _App(tmp_path) as core:
        assert core.client.get("/api/v1/sources/nope/files").status_code == 404


def test_an_unauthorized_source_is_refused(tmp_path):
    with _App(tmp_path) as core:
        response = core.client.get("/api/v1/sources/codex/files")

    assert response.status_code == 403
    assert response.json()["detail"] == "source_not_authorized"


def test_the_manifest_route_round_trips_through_an_append(tmp_path):
    with _App(tmp_path) as core:
        core.grant()
        empty = core.client.get("/api/v1/sources/codex/files")
        assert empty.status_code == 200
        assert empty.json()["files"] == []

        written = core.client.post(
            "/api/v1/sources/codex/files",
            json={
                "path": "sessions/a.jsonl",
                "offset": 0,
                "tail_hash": EMPTY_TAIL,
                "data": base64.b64encode(b'{"id":1}\n').decode(),
            },
        )
        assert written.status_code == 200
        body = written.json()
        assert body["size"] == 9

        manifest = core.client.get("/api/v1/sources/codex/files").json()
        assert manifest["files"] == [
            {"path": "sessions/a.jsonl", "size": 9, "tail_hash": body["tail_hash"]}
        ]
        # The importer's root and the write target are the same directory.
        assert (core.root / "sessions/a.jsonl").read_bytes() == b'{"id":1}\n'


def test_a_conflicting_append_answers_409(tmp_path):
    with _App(tmp_path) as core:
        core.grant()
        response = core.client.post(
            "/api/v1/sources/codex/files",
            json={
                "path": "sessions/a.jsonl",
                "offset": 5,
                "tail_hash": EMPTY_TAIL,
                "data": base64.b64encode(b"x").decode(),
            },
        )

    assert response.status_code == 409
    assert response.json()["detail"] == "sync_offset_mismatch"


@pytest.mark.parametrize(
    "change",
    [
        {"data": "not base64!!"},
        {"tail_hash": "nope"},
        {"offset": -1},
        {"path": "../escape.jsonl"},
        {"path": "/abs.jsonl"},
    ],
)
def test_a_malformed_append_is_rejected_before_it_reaches_the_store(tmp_path, change):
    payload = {
        "path": "sessions/a.jsonl",
        "offset": 0,
        "tail_hash": EMPTY_TAIL,
        "data": base64.b64encode(b"x").decode(),
    } | change
    with _App(tmp_path) as core:
        core.grant()
        response = core.client.post("/api/v1/sources/codex/files", json=payload)

    assert response.status_code == 422
