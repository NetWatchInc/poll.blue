-- poll.blue database schema (reference). The production DB already has these
-- tables; this documents them and bootstraps a fresh local Postgres.

CREATE TABLE IF NOT EXISTS polls (
  id             integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_uri       varchar(100) UNIQUE,
  posted_by      varchar(100),
  question       varchar(200) NOT NULL,
  answers        jsonb NOT NULL,
  results        jsonb NOT NULL,           -- [abstentions, votesForOpt1, ...]
  visible_id     varchar(16) NOT NULL UNIQUE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  results_posted boolean NOT NULL DEFAULT true,
  user_agent     varchar(100) NOT NULL DEFAULT 'poll.blue'
);

CREATE TABLE IF NOT EXISTS votes (
  id      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip      integer,
  poll_id integer REFERENCES polls(id),
  vote    smallint
);

-- one vote per IP per poll
CREATE UNIQUE INDEX IF NOT EXISTS votes_idx ON votes (ip, poll_id);
CREATE INDEX IF NOT EXISTS polls_created_at_idx ON polls (created_at);
