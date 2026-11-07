"""The receiving end of cross-machine sync.

Two things are worth pinning here and they are different failures:

* the manifest is the only resume state, so it has to be derived from the files
  rather than remembered;
* an append is validated against the bytes we hold, because a host may have
  rewritten its copy while we were unreachable and appending to a file the two
  sides disagree about produces a transcript that parses as nothing.
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
def store(tmp_path):
    return ReceivedFileStore(tmp_path / "received")


def append(store, path, data, *, offset=0, tail_hash=EMPTY_TAIL, source="codex"):
    return store.append(source, path, offset=offset, tail_hash=tail_hash, data=data)


def test_manifest_of_an_unknown_source_is_empty(store):
    assert store.manifest("codex") == ()


def test_append_creates_the_file_and_reports_what_it_holds(store):
    record = append(store, "sessions/a.jsonl", b'{"id":1}\n')

    assert record.path == "sessions/a.jsonl"
    assert record.size == 9
    assert record.tail_hash == tail(b'{"id":1}\n')
    assert store.manifest("codex") == (record,)


def test_append_continues_from_the_offset_the_manifest_reported(store):
    first = append(store, "sessions/a.jsonl", b'{"id":1}\n')
    second = append(
        store,
        "sessions/a.jsonl",
        b'{"id":2}\n',
        offset=first.size,
        tail_hash=first.tail_hash,
    )

    assert second.size == 18
    assert (store.source_root("codex") / "sessions/a.jsonl").read_bytes() == (
        b'{"id":1}\n{"id":2}\n'
    )


def test_a_stale_offset_is_refused_rather_than_appended(store):
    first = append(store, "sessions/a.jsonl", b'{"id":1}\n')

    with pytest.raises(SyncConflict) as raised:
        append(store, "sessions/a.jsonl", b'{"id":2}\n', offset=0, tail_hash=EMPTY_TAIL)
    assert raised.value.code == "sync_offset_mismatch"
    # The file must be untouched: a refused append that wrote anyway would
    # corrupt the transcript for the next pass too.
    assert (store.source_root("codex") / "sessions/a.jsonl").read_bytes() == b'{"id":1}\n'
    assert first.size == 9


def test_a_tail_that_does_not_match_is_refused(store):
    first = append(store, "sessions/a.jsonl", b'{"id":1}\n')
    wrong = tail(b"something else entirely")

    with pytest.raises(SyncConflict) as raised:
        append(store, "sessions/a.jsonl", b'{"id":2}\n', offset=first.size, tail_hash=wrong)
    assert raised.value.code == "sync_tail_mismatch"


def test_tail_hash_covers_only_the_last_window(store):
    long_record = b"x" * 9000
    first = append(store, "sessions/big.jsonl", long_record)

    assert first.tail_hash == hashlib.sha256(long_record[-4096:]).hexdigest()
    assert first.tail_hash != hashlib.sha256(long_record).hexdigest()


def test_the_manifest_sees_every_file_and_no_directories(store):
    append(store, "a/one.jsonl", b"1\n")
    append(store, "a/two.jsonl", b"2\n")
    append(store, "b/three.jsonl", b"3\n")

    assert [item.path for item in store.manifest("codex")] == [
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
def test_a_path_that_could_leave_the_root_is_refused(store, path):
    with pytest.raises(ValueError):
        append(store, path, b"x")


def test_a_path_that_traverses_through_a_symlink_is_refused(store, tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    base = store.source_root("codex")
    base.mkdir(parents=True)
    (base / "link").symlink_to(outside, target_is_directory=True)

    with pytest.raises(ValueError):
        append(store, "link/escape.jsonl", b"x")
    assert list(outside.iterdir()) == []


def test_an_append_larger_than_the_cap_is_refused(store):
    with pytest.raises(ValueError):
        append(store, "big.jsonl", b"x" * (MAX_APPEND_BYTES + 1))


def test_a_malformed_tail_hash_is_refused(store):
    with pytest.raises(ValueError):
        append(store, "a.jsonl", b"x", tail_hash="not-a-hash")


def test_one_source_cannot_see_another(store):
    append(store, "a.jsonl", b"codex\n", source="codex")
    append(store, "a.jsonl", b"cursor\n", source="cursor")

    assert [item.path for item in store.manifest("codex")] == ["a.jsonl"]
    assert (store.source_root("codex") / "a.jsonl").read_bytes() == b"codex\n"
    assert (store.source_root("cursor") / "a.jsonl").read_bytes() == b"cursor\n"


def test_a_directory_sitting_where_a_file_belongs_is_refused(store):
    base = store.source_root("codex")
    (base / "a.jsonl").mkdir(parents=True)

    with pytest.raises(ValueError):
        append(store, "a.jsonl", b"x")


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
