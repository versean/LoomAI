CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS workspaces (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email         text NOT NULL,
    display_name  text NOT NULL,
    is_admin      boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, email)
);

CREATE TABLE IF NOT EXISTS projects (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id      uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    slug              text NOT NULL,
    name              text NOT NULL,
    description       text NOT NULL DEFAULT '',
    brief             text,
    brief_updated_at  timestamptz,
    created_at        timestamptz NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS memberships (
    project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        text NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);

CREATE TABLE IF NOT EXISTS invites (
    code_hash     text PRIMARY KEY,
    workspace_id  uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    email         text NOT NULL,
    display_name  text NOT NULL,
    project_id    uuid REFERENCES projects(id) ON DELETE CASCADE,
    role          text NOT NULL CHECK (role IN ('owner', 'member', 'viewer')),
    created_by    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at    timestamptz NOT NULL,
    used_at       timestamptz
);
-- Team links have no email or name (each person gives their own when joining) and work up to max_uses times.
-- used_at is set once the last use is taken; cancelling a link sets expires_at to now.
ALTER TABLE invites ALTER COLUMN email DROP NOT NULL;
ALTER TABLE invites ALTER COLUMN display_name DROP NOT NULL;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS max_uses integer NOT NULL DEFAULT 1;
ALTER TABLE invites ADD COLUMN IF NOT EXISTS uses integer NOT NULL DEFAULT 0;

-- One row per connected computer; every agent on it acts through this token.
CREATE TABLE IF NOT EXISTS devices (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name          text NOT NULL,
    token_hash    text NOT NULL UNIQUE,
    scopes        text[] NOT NULL DEFAULT ARRAY['read', 'share'],
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_seen_at  timestamptz NOT NULL DEFAULT now(),
    last_client   text,
    revoked_at    timestamptz
);

CREATE TABLE IF NOT EXISTS documents (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path          text NOT NULL,
    kind          text NOT NULL CHECK (kind IN ('file', 'note')),
    source        text NOT NULL,
    content_hash  text NOT NULL,
    blob_key      text NOT NULL,
    size_bytes    integer NOT NULL,
    language      text,
    created_by    uuid REFERENCES users(id) ON DELETE SET NULL,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, path)
);

CREATE TABLE IF NOT EXISTS chunks (
    id           bigserial PRIMARY KEY,
    document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path         text NOT NULL,
    ordinal      integer NOT NULL,
    heading      text,
    start_line   integer NOT NULL,
    end_line     integer NOT NULL,
    content      text NOT NULL,
    embedding    vector(1024) NOT NULL,
    embed_model  text NOT NULL,
    -- Separators are split so that "src/auth/login_user.py" matches a query for "login user".
    tsv          tsvector GENERATED ALWAYS AS (
        to_tsvector(
            'simple'::regconfig,
            regexp_replace(path || ' ' || coalesce(heading, '') || ' ' || content, '[/._:-]+', ' ', 'g')
        )
    ) STORED
);
CREATE INDEX IF NOT EXISTS chunks_project_idx ON chunks (project_id);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS artifacts (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    sender_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('file', 'skill', 'message')),
    filename      text NOT NULL,
    install_path  text,
    blob_key      text NOT NULL,
    content_hash  text NOT NULL,
    size_bytes    integer NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deliveries (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_id   uuid NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    recipient_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note          text NOT NULL DEFAULT '',
    status        text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'accepted', 'declined')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    acted_at      timestamptz
);
CREATE INDEX IF NOT EXISTS deliveries_recipient_idx ON deliveries (recipient_id, status);

CREATE TABLE IF NOT EXISTS audit_events (
    id            bigserial PRIMARY KEY,
    at            timestamptz NOT NULL DEFAULT now(),
    workspace_id  uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
    device_id     uuid REFERENCES devices(id) ON DELETE SET NULL,
    client        text,
    action        text NOT NULL,
    project_id    uuid REFERENCES projects(id) ON DELETE SET NULL,
    decision      text NOT NULL CHECK (decision IN ('allow', 'deny', 'error')),
    reason        text,
    latency_ms    integer,
    detail        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_workspace_idx ON audit_events (workspace_id, id DESC);

CREATE TABLE IF NOT EXISTS conversation_turns (
    id               bigserial PRIMARY KEY,
    device_id        uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    session_key      text NOT NULL,
    question         text NOT NULL,
    standalone_query text NOT NULL,
    answer           text NOT NULL,
    sources          jsonb NOT NULL DEFAULT '[]'::jsonb,
    at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS turns_session_idx ON conversation_turns (device_id, session_key, at DESC);
