import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Schema history. Each entry upgrades the database by one version; never edit
 * an entry that has shipped, append a new one instead.
 */
const MIGRATIONS: readonly string[] = [
  `
  -- Voice channels that create a personal channel for whoever joins them.
  CREATE TABLE hubs (
    channel_id TEXT PRIMARY KEY,
    guild_id   TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX hubs_by_guild ON hubs (guild_id);

  -- What a member last chose for their channel. NULL means "use the default".
  CREATE TABLE profiles (
    guild_id      TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    name          TEXT,
    user_limit    INTEGER,
    bitrate       INTEGER,
    rtc_region    TEXT,
    video_quality INTEGER,
    privacy       TEXT CHECK (privacy IN ('hidden', 'locked', 'public')),
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );

  -- Who a member always lets into, or keeps out of, their channels.
  CREATE TABLE profile_access (
    guild_id  TEXT NOT NULL,
    owner_id  TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kind      TEXT NOT NULL CHECK (kind IN ('allow', 'block')),
    PRIMARY KEY (guild_id, owner_id, target_id)
  );

  -- Personal channels that currently exist.
  CREATE TABLE temp_channels (
    channel_id       TEXT PRIMARY KEY,
    guild_id         TEXT NOT NULL,
    hub_id           TEXT,
    owner_id         TEXT NOT NULL,
    privacy          TEXT NOT NULL CHECK (privacy IN ('hidden', 'locked', 'public')),
    panel_message_id TEXT,
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX temp_channels_by_owner ON temp_channels (guild_id, owner_id);

  -- Access lists of a live channel. Starts as a copy of the owner's profile lists.
  CREATE TABLE channel_access (
    channel_id TEXT NOT NULL REFERENCES temp_channels (channel_id) ON DELETE CASCADE,
    target_id  TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('allow', 'block')),
    PRIMARY KEY (channel_id, target_id)
  );

  -- Members who are muted or deafened for as long as they are in a given channel.
  CREATE TABLE channel_sanctions (
    channel_id TEXT NOT NULL REFERENCES temp_channels (channel_id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL,
    muted      INTEGER NOT NULL DEFAULT 0,
    deafened   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, user_id)
  );

  -- Server mutes and deafens this bot applied and is therefore responsible for lifting.
  CREATE TABLE applied_sanctions (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    muted    INTEGER NOT NULL DEFAULT 0,
    deafened INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  );
  `,
];

/** Opens (creating if needed) the database and brings its schema up to date. */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ':memory:') mkdirSync(path.dirname(path.resolve(file)), { recursive: true });

  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  let version = Number(row.user_version);

  if (version > MIGRATIONS.length) {
    throw new Error(
      `The database is at schema version ${version}, but this build only knows up to ${MIGRATIONS.length}. ` +
        'It was probably written by a newer version of the bot.',
    );
  }

  for (; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
