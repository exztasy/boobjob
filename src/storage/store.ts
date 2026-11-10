import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';

/**
 * Who can get into a channel:
 * - `hidden`: only the owner and allowed users can see or join it
 * - `locked`: visible like any other channel in its category, but only the owner and allowed users can join
 * - `public`: follows the category's permissions; blocked users are still kept out
 */
export type Privacy = 'hidden' | 'locked' | 'public';

export const PRIVACY_MODES: readonly Privacy[] = ['hidden', 'locked', 'public'];

export type AccessKind = 'allow' | 'block';

export interface Hub {
  channelId: string;
  guildId: string;
  createdAt: number;
}

/** A member's saved channel settings. `null` means "not chosen, use the default". */
export interface ProfileSettings {
  name: string | null;
  userLimit: number | null;
  bitrate: number | null;
  rtcRegion: string | null;
  videoQuality: number | null;
  privacy: Privacy | null;
}

export interface TempChannel {
  channelId: string;
  guildId: string;
  hubId: string | null;
  ownerId: string;
  privacy: Privacy;
  panelMessageId: string | null;
  createdAt: number;
}

export interface AccessLists {
  allowed: string[];
  blocked: string[];
}

export interface Sanction {
  muted: boolean;
  deafened: boolean;
}

export interface MemberSanction extends Sanction {
  userId: string;
}

const NO_SANCTION: Sanction = Object.freeze({ muted: false, deafened: false });

const PROFILE_COLUMNS: Record<keyof ProfileSettings, string> = {
  name: 'name',
  userLimit: 'user_limit',
  bitrate: 'bitrate',
  rtcRegion: 'rtc_region',
  videoQuality: 'video_quality',
  privacy: 'privacy',
};

const TEMP_CHANNEL_COLUMNS = `
  channel_id AS channelId, guild_id AS guildId, hub_id AS hubId, owner_id AS ownerId,
  privacy, panel_message_id AS panelMessageId, created_at AS createdAt`;

interface AccessRow {
  targetId: string;
  kind: AccessKind;
}

interface SanctionRow {
  userId: string;
  muted: number;
  deafened: number;
}

/** All persistent state. Every method is synchronous and atomic. */
export class Store {
  private readonly statements = new Map<string, StatementSync>();
  private transactionDepth = 0;

  constructor(private readonly db: DatabaseSync) {}

  close(): void {
    this.statements.clear();
    this.db.close();
  }

  // ── hubs ────────────────────────────────────────────────────────────────

  addHub(guildId: string, channelId: string, now = Date.now()): void {
    this.write('INSERT OR IGNORE INTO hubs (channel_id, guild_id, created_at) VALUES (?, ?, ?)', channelId, guildId, now);
  }

  removeHub(channelId: string): boolean {
    return this.write('DELETE FROM hubs WHERE channel_id = ?', channelId) > 0;
  }

  getHub(channelId: string): Hub | undefined {
    return this.one<Hub>(
      'SELECT channel_id AS channelId, guild_id AS guildId, created_at AS createdAt FROM hubs WHERE channel_id = ?',
      channelId,
    );
  }

  listHubs(guildId: string): Hub[] {
    return this.many<Hub>(
      'SELECT channel_id AS channelId, guild_id AS guildId, created_at AS createdAt FROM hubs WHERE guild_id = ? ORDER BY created_at, channel_id',
      guildId,
    );
  }

  // ── profiles ────────────────────────────────────────────────────────────

  getProfile(guildId: string, userId: string): ProfileSettings | undefined {
    return this.one<ProfileSettings>(
      `SELECT name, user_limit AS userLimit, bitrate, rtc_region AS rtcRegion,
              video_quality AS videoQuality, privacy
         FROM profiles WHERE guild_id = ? AND user_id = ?`,
      guildId,
      userId,
    );
  }

  /** Saves the given settings for a member, leaving the ones not mentioned untouched. */
  updateProfile(guildId: string, userId: string, patch: Partial<ProfileSettings>, now = Date.now()): void {
    const keys = (Object.keys(patch) as (keyof ProfileSettings)[]).filter((key) => patch[key] !== undefined);
    if (keys.length === 0) return;

    this.transaction(() => {
      this.write(
        'INSERT OR IGNORE INTO profiles (guild_id, user_id, updated_at) VALUES (?, ?, ?)',
        guildId,
        userId,
        now,
      );
      const assignments = keys.map((key) => `${PROFILE_COLUMNS[key]} = ?`).join(', ');
      const values = keys.map((key) => patch[key] ?? null);
      this.write(
        `UPDATE profiles SET ${assignments}, updated_at = ? WHERE guild_id = ? AND user_id = ?`,
        ...values,
        now,
        guildId,
        userId,
      );
    });
  }

  getProfileAccess(guildId: string, ownerId: string): AccessLists {
    return toLists(
      this.many<AccessRow>(
        'SELECT target_id AS targetId, kind FROM profile_access WHERE guild_id = ? AND owner_id = ? ORDER BY rowid',
        guildId,
        ownerId,
      ),
    );
  }

  /** Puts `add` on the given list (taking them off the other one) and takes `remove` off it. */
  changeProfileAccess(guildId: string, ownerId: string, kind: AccessKind, add: readonly string[], remove: readonly string[]): void {
    this.transaction(() => {
      for (const targetId of remove) {
        this.write(
          'DELETE FROM profile_access WHERE guild_id = ? AND owner_id = ? AND target_id = ? AND kind = ?',
          guildId,
          ownerId,
          targetId,
          kind,
        );
      }
      for (const targetId of add) {
        this.write(
          `INSERT INTO profile_access (guild_id, owner_id, target_id, kind) VALUES (?, ?, ?, ?)
           ON CONFLICT (guild_id, owner_id, target_id) DO UPDATE SET kind = excluded.kind`,
          guildId,
          ownerId,
          targetId,
          kind,
        );
      }
    });
  }

  // ── live channels ───────────────────────────────────────────────────────

  createTempChannel(channel: Omit<TempChannel, 'panelMessageId'>, access: AccessLists): void {
    this.transaction(() => {
      this.write(
        `INSERT INTO temp_channels (channel_id, guild_id, hub_id, owner_id, privacy, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        channel.channelId,
        channel.guildId,
        channel.hubId,
        channel.ownerId,
        channel.privacy,
        channel.createdAt,
      );
      this.changeChannelAccess(channel.channelId, 'block', access.blocked, []);
      this.changeChannelAccess(channel.channelId, 'allow', access.allowed, []);
    });
  }

  getTempChannel(channelId: string): TempChannel | undefined {
    return this.one<TempChannel>(`SELECT ${TEMP_CHANNEL_COLUMNS} FROM temp_channels WHERE channel_id = ?`, channelId);
  }

  /** The channel a member owns in a guild. A member owns at most one at a time. */
  getTempChannelByOwner(guildId: string, ownerId: string): TempChannel | undefined {
    return this.one<TempChannel>(
      `SELECT ${TEMP_CHANNEL_COLUMNS} FROM temp_channels
        WHERE guild_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 1`,
      guildId,
      ownerId,
    );
  }

  listTempChannels(guildId: string): TempChannel[] {
    return this.many<TempChannel>(
      `SELECT ${TEMP_CHANNEL_COLUMNS} FROM temp_channels WHERE guild_id = ? ORDER BY created_at, channel_id`,
      guildId,
    );
  }

  /** Forgets a channel together with its access lists and sanctions. */
  deleteTempChannel(channelId: string): boolean {
    return this.write('DELETE FROM temp_channels WHERE channel_id = ?', channelId) > 0;
  }

  setPrivacy(channelId: string, privacy: Privacy): void {
    this.write('UPDATE temp_channels SET privacy = ? WHERE channel_id = ?', privacy, channelId);
  }

  setPanelMessage(channelId: string, messageId: string | null): void {
    this.write('UPDATE temp_channels SET panel_message_id = ? WHERE channel_id = ?', messageId, channelId);
  }

  /**
   * Hands a channel to a new owner. The new owner no longer needs an entry on
   * the access lists; the previous owner is put on the allow list when
   * `keepPreviousOwner` is set, so they can still get back in.
   */
  transferOwnership(channelId: string, newOwnerId: string, keepPreviousOwner: boolean): void {
    this.transaction(() => {
      const current = this.getTempChannel(channelId);
      if (!current || current.ownerId === newOwnerId) return;
      this.write('UPDATE temp_channels SET owner_id = ? WHERE channel_id = ?', newOwnerId, channelId);
      this.write('DELETE FROM channel_access WHERE channel_id = ? AND target_id = ?', channelId, newOwnerId);
      if (keepPreviousOwner) {
        this.write(
          "INSERT OR IGNORE INTO channel_access (channel_id, target_id, kind) VALUES (?, ?, 'allow')",
          channelId,
          current.ownerId,
        );
      }
    });
  }

  getChannelAccess(channelId: string): AccessLists {
    return toLists(
      this.many<AccessRow>(
        'SELECT target_id AS targetId, kind FROM channel_access WHERE channel_id = ? ORDER BY rowid',
        channelId,
      ),
    );
  }

  /** Puts `add` on the given list (taking them off the other one) and takes `remove` off it. */
  changeChannelAccess(channelId: string, kind: AccessKind, add: readonly string[], remove: readonly string[]): void {
    this.transaction(() => {
      for (const targetId of remove) {
        this.write(
          'DELETE FROM channel_access WHERE channel_id = ? AND target_id = ? AND kind = ?',
          channelId,
          targetId,
          kind,
        );
      }
      for (const targetId of add) {
        this.write(
          `INSERT INTO channel_access (channel_id, target_id, kind) VALUES (?, ?, ?)
           ON CONFLICT (channel_id, target_id) DO UPDATE SET kind = excluded.kind`,
          channelId,
          targetId,
          kind,
        );
      }
    });
  }

  /** Replaces a channel's access lists wholesale; used to undo a change that could not be applied. */
  setChannelAccess(channelId: string, access: AccessLists): void {
    this.transaction(() => {
      this.write('DELETE FROM channel_access WHERE channel_id = ?', channelId);
      this.changeChannelAccess(channelId, 'block', access.blocked, []);
      this.changeChannelAccess(channelId, 'allow', access.allowed, []);
    });
  }

  // ── mute / deafen ───────────────────────────────────────────────────────

  /** Whether a member is to be muted or deafened while they are in a channel. */
  getSanction(channelId: string, userId: string): Sanction {
    const row = this.one<SanctionRow>(
      'SELECT user_id AS userId, muted, deafened FROM channel_sanctions WHERE channel_id = ? AND user_id = ?',
      channelId,
      userId,
    );
    return row ? { muted: row.muted === 1, deafened: row.deafened === 1 } : NO_SANCTION;
  }

  /** Changes the given flags and returns the member's resulting sanction for the channel. */
  setSanction(channelId: string, userId: string, patch: Partial<Sanction>): Sanction {
    return this.transaction(() => {
      const next = { ...this.getSanction(channelId, userId), ...definedOnly(patch) };
      if (next.muted || next.deafened) {
        this.write(
          `INSERT INTO channel_sanctions (channel_id, user_id, muted, deafened) VALUES (?, ?, ?, ?)
           ON CONFLICT (channel_id, user_id) DO UPDATE SET muted = excluded.muted, deafened = excluded.deafened`,
          channelId,
          userId,
          Number(next.muted),
          Number(next.deafened),
        );
      } else {
        this.write('DELETE FROM channel_sanctions WHERE channel_id = ? AND user_id = ?', channelId, userId);
      }
      return next;
    });
  }

  listSanctions(channelId: string): MemberSanction[] {
    return this.many<SanctionRow>(
      'SELECT user_id AS userId, muted, deafened FROM channel_sanctions WHERE channel_id = ? ORDER BY rowid',
      channelId,
    ).map(toMemberSanction);
  }

  /** What this bot has applied to a member's server-wide voice state and still has to lift. */
  getApplied(guildId: string, userId: string): Sanction {
    const row = this.one<SanctionRow>(
      'SELECT user_id AS userId, muted, deafened FROM applied_sanctions WHERE guild_id = ? AND user_id = ?',
      guildId,
      userId,
    );
    return row ? { muted: row.muted === 1, deafened: row.deafened === 1 } : NO_SANCTION;
  }

  setApplied(guildId: string, userId: string, applied: Sanction): void {
    if (applied.muted || applied.deafened) {
      this.write(
        `INSERT INTO applied_sanctions (guild_id, user_id, muted, deafened) VALUES (?, ?, ?, ?)
         ON CONFLICT (guild_id, user_id) DO UPDATE SET muted = excluded.muted, deafened = excluded.deafened`,
        guildId,
        userId,
        Number(applied.muted),
        Number(applied.deafened),
      );
    } else {
      this.write('DELETE FROM applied_sanctions WHERE guild_id = ? AND user_id = ?', guildId, userId);
    }
  }

  /** Everyone in a guild whose voice state this bot may need to correct. */
  listSanctionedUsers(guildId: string): string[] {
    return this.many<{ userId: string }>(
      `SELECT s.user_id AS userId FROM channel_sanctions s
         JOIN temp_channels t ON t.channel_id = s.channel_id
        WHERE t.guild_id = ?
       UNION
       SELECT user_id AS userId FROM applied_sanctions WHERE guild_id = ?`,
      guildId,
      guildId,
    ).map((row) => row.userId);
  }

  // ── plumbing ────────────────────────────────────────────────────────────

  private transaction<T>(work: () => T): T {
    if (this.transactionDepth > 0) return work();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private one<T extends object>(sql: string, ...params: SQLInputValue[]): T | undefined {
    const row = this.prepare(sql).get(...params);
    return row ? ({ ...row } as T) : undefined;
  }

  private many<T extends object>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.prepare(sql).all(...params).map((row) => ({ ...row }) as T);
  }

  private write(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.prepare(sql).run(...params).changes);
  }
}

function toLists(rows: AccessRow[]): AccessLists {
  const lists: AccessLists = { allowed: [], blocked: [] };
  for (const row of rows) (row.kind === 'allow' ? lists.allowed : lists.blocked).push(row.targetId);
  return lists;
}

function toMemberSanction(row: SanctionRow): MemberSanction {
  return { userId: row.userId, muted: row.muted === 1, deafened: row.deafened === 1 };
}

function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
