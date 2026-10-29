-- Pingwell initial schema

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

CREATE TYPE monitor_status AS ENUM ('pending', 'up', 'down', 'paused');
CREATE TYPE http_method AS ENUM ('GET', 'HEAD', 'POST');

CREATE TABLE monitors (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  url                   text NOT NULL,
  method                http_method NOT NULL DEFAULT 'GET',
  headers               jsonb NOT NULL DEFAULT '{}'::jsonb,
  body                  text,
  expected_status_min   int NOT NULL DEFAULT 200,
  expected_status_max   int NOT NULL DEFAULT 399,
  keyword               text,
  timeout_ms            int NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 60000),
  interval_seconds      int NOT NULL DEFAULT 60 CHECK (interval_seconds >= 10),
  failure_threshold     int NOT NULL DEFAULT 2 CHECK (failure_threshold BETWEEN 1 AND 10),
  recovery_threshold    int NOT NULL DEFAULT 1 CHECK (recovery_threshold BETWEEN 1 AND 10),
  slow_threshold_ms     int CHECK (slow_threshold_ms IS NULL OR slow_threshold_ms > 0),

  status                monitor_status NOT NULL DEFAULT 'pending',
  consecutive_failures  int NOT NULL DEFAULT 0,
  consecutive_successes int NOT NULL DEFAULT 0,
  last_checked_at       timestamptz,
  last_response_ms      int,
  last_error            text,
  next_check_at         timestamptz NOT NULL DEFAULT now(),
  paused                boolean NOT NULL DEFAULT false,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (expected_status_min <= expected_status_max)
);
CREATE INDEX monitors_user_idx ON monitors (user_id);
-- The scheduler's hot path: due, unpaused monitors in due order.
CREATE INDEX monitors_due_idx ON monitors (next_check_at) WHERE NOT paused;

CREATE TABLE check_results (
  id           bigserial PRIMARY KEY,
  monitor_id   uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  checked_at   timestamptz NOT NULL DEFAULT now(),
  ok           boolean NOT NULL,
  status_code  int,
  response_ms  int,
  error        text
);
CREATE INDEX check_results_monitor_time_idx ON check_results (monitor_id, checked_at DESC);
CREATE INDEX check_results_time_idx ON check_results (checked_at);

CREATE TABLE incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  monitor_id       uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  started_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at      timestamptz,
  cause            text NOT NULL,
  acknowledged_at  timestamptz,
  acknowledged_by  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX incidents_monitor_idx ON incidents (monitor_id, started_at DESC);
-- At most one open incident per monitor, enforced by the database.
CREATE UNIQUE INDEX incidents_one_open_per_monitor ON incidents (monitor_id) WHERE resolved_at IS NULL;

CREATE TYPE incident_event_type AS ENUM ('opened', 'check_failed', 'acknowledged', 'note', 'resolved', 'alert_sent', 'alert_failed');

CREATE TABLE incident_events (
  id           bigserial PRIMARY KEY,
  incident_id  uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  at           timestamptz NOT NULL DEFAULT now(),
  type         incident_event_type NOT NULL,
  message      text NOT NULL,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX incident_events_incident_idx ON incident_events (incident_id, at);

CREATE TYPE channel_type AS ENUM ('email', 'slack', 'discord', 'webhook');

CREATE TABLE alert_channels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        channel_type NOT NULL,
  name        text NOT NULL,
  -- email: { to }, slack/discord: { url }, webhook: { url, secret }
  config      jsonb NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX alert_channels_user_idx ON alert_channels (user_id);

CREATE TABLE monitor_channels (
  monitor_id  uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  channel_id  uuid NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE,
  PRIMARY KEY (monitor_id, channel_id)
);

-- One row per (incident event, channel): makes alert delivery idempotent across retries and redeliveries.
CREATE TABLE alert_deliveries (
  id           bigserial PRIMARY KEY,
  incident_id  uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  channel_id   uuid NOT NULL REFERENCES alert_channels(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('opened', 'resolved')),
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts     int NOT NULL DEFAULT 0,
  last_error   text,
  sent_at      timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, channel_id, kind)
);

CREATE TABLE status_pages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug         text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$'),
  title        text NOT NULL,
  description  text,
  published    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE status_page_monitors (
  status_page_id  uuid NOT NULL REFERENCES status_pages(id) ON DELETE CASCADE,
  monitor_id      uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  position        int NOT NULL DEFAULT 0,
  display_name    text,
  PRIMARY KEY (status_page_id, monitor_id)
);
