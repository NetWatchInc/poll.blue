-- poll.blue database schema (reference). The production DB already has these
-- tables; this documents them and bootstraps a fresh local Postgres.

CREATE TABLE IF NOT EXISTS polls (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_uri       text UNIQUE,
  posted_by      varchar(100),
  question       text NOT NULL,
  answers        jsonb NOT NULL,
  results        jsonb NOT NULL,           -- [abstentions, votesForOpt1, ...]
  visible_id     varchar(16) NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  results_posted boolean NOT NULL DEFAULT true,
  user_agent     varchar(100) NOT NULL DEFAULT 'poll.blue',
  blue_poll_uri  varchar(200)             -- at-uri of the creator's manage-able poll record (anonymous polls)
);

-- Existing production DBs: add the manage-able-record column if missing.
ALTER TABLE polls ADD COLUMN IF NOT EXISTS blue_poll_uri varchar(200);

-- Widen columns that used to be length-capped (question was varchar(200);
-- post_uri varchar(100) could overflow for long did:web URIs). Guarded so the
-- startup migration only touches them when needed.
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'polls' AND column_name = 'question') <> 'text' THEN
    ALTER TABLE polls ALTER COLUMN question TYPE text;
  END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_name = 'polls' AND column_name = 'post_uri') <> 'text' THEN
    ALTER TABLE polls ALTER COLUMN post_uri TYPE text;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS votes (
  id      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip      integer,
  poll_id integer REFERENCES polls(id),
  vote    smallint
);

-- one vote per IP per poll
CREATE UNIQUE INDEX IF NOT EXISTS votes_idx ON votes (ip, poll_id);
CREATE INDEX IF NOT EXISTS polls_created_at_idx ON polls (created_at);
