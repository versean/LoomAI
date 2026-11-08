import numpy as np

from loom_common.secrets import scan_text
from loom_server.chunking import chunk_document
from loom_server.policy import decide_share
from loom_server.providers.embeddings import DIM, HashEmbedder
from loom_server.providers.rerank import LexicalReranker
from loom_server.providers.text import content_terms, stem, tokenize
from loom_server.retrieval import build_tsquery

ALLOWED = {
    "sender_role": "member",
    "device_scopes": ["read", "share"],
    "recipient_role": "member",
    "recipient_is_sender": False,
    "sensitive_path": False,
    "findings": [],
}


def test_share_allowed_between_members():
    assert decide_share(**ALLOWED) is None


def test_share_denials():
    assert "read-only" in decide_share(**ALLOWED | {"device_scopes": ["read"]})
    assert "Sender is not a member" in decide_share(**ALLOWED | {"sender_role": None})
    assert "viewer" in decide_share(**ALLOWED | {"sender_role": "viewer"})
    assert "Recipient is not a member" in decide_share(**ALLOWED | {"recipient_role": None})
    assert "same person" in decide_share(**ALLOWED | {"recipient_is_sender": True})
    assert "Credential files" in decide_share(**ALLOWED | {"sensitive_path": True})
    leaked = scan_text("token = ghp_abcdefghijklmnopqrstuvwxyz0123456789")
    assert "secrets" in decide_share(**ALLOWED | {"findings": leaked})


def test_small_file_is_one_chunk():
    chunks = chunk_document("a.py", "def f():\n    return 1\n")
    assert len(chunks) == 1
    assert (chunks[0].start_line, chunks[0].end_line) == (1, 2)


def test_markdown_chunks_carry_heading_breadcrumbs():
    body = "word " * 400
    text = f"# Guide\n\n{body}\n\n## Install\n\n{body}\n\n```\n# not a heading\n```\n\n## Usage\n\n{body}\n"
    chunks = chunk_document("README.md", text)
    headings = [c.heading for c in chunks]
    assert "Guide > Install" in headings
    assert "Guide > Usage" in headings
    assert not any(h and "not a heading" in h for h in headings)


def test_code_chunks_start_at_definitions_with_line_numbers():
    filler = "\n".join(f"    x{i} = {i}" for i in range(120))
    text = f"import os\n\n\n@decorator\ndef first(\n    a,\n):\n{filler}\n\n\nclass Second:\n{filler}\n"
    chunks = chunk_document("mod.py", text)
    lines = text.splitlines()
    for chunk in chunks:
        assert chunk.text.splitlines()[0] == lines[chunk.start_line - 1]
    assert any(c.heading == "def first(…)" for c in chunks)
    assert any(c.heading == "class Second" for c in chunks)
    assert any("@decorator\ndef first(" in c.text for c in chunks)


def test_tokenize_splits_identifiers():
    assert tokenize("hybridSearch snake_case") == ["hybrid", "search", "snake", "case"]
    assert content_terms("What is the refusal threshold?") == ["refusal", "threshold"]


def test_stem_unifies_word_forms():
    assert stem("sending") == stem("sends") == stem("send")
    assert stem("secrets") == stem("secret")
    assert stem("stored") == stem("store")
    assert stem("class") == "class"


def test_tsquery_only_contains_safe_terms():
    query = build_tsquery("How does api.py handle 'x' | !drop & tables?")
    assert set(query.replace(" | ", " ").split()) <= {"api", "py", "handle", "drop", "tables"}
    assert "'" not in query and "!" not in query and "&" not in query


def test_hash_embedder_prefers_related_text():
    embedder = HashEmbedder()
    query = embedder.embed_query("send a file to a teammate")
    related, unrelated = embedder.embed_documents(["deliver files to teammates' inbox", "chocolate cake recipe"])
    assert query.shape == (DIM,)
    assert np.isclose(np.linalg.norm(query), 1.0)
    assert query @ related > query @ unrelated


def test_lexical_reranker_scores_coverage():
    scores = LexicalReranker().score(
        "How are secrets detected before sending?",
        ["We detect secrets before sending any file.", "Launch the pitch at 9am."],
    )
    assert scores[0] >= LexicalReranker.default_threshold > scores[1]
