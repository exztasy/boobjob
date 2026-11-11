import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { DatabaseError, openDatabase } from '../src/storage/database.js';
import { Store } from '../src/storage/store.js';

const GUILD = 'guild';
const OTHER_GUILD = 'other-guild';

function memoryStore(t: TestContext): Store {
  const store = new Store(openDatabase(':memory:'));
  t.after(() => store.close());
  return store;
}

function addChannel(store: Store, channelId: string, ownerId: string, createdAt = 1): void {
  store.createTempChannel(
    { channelId, guildId: GUILD, hubId: 'hub', ownerId, privacy: 'hidden', createdAt },
    { allowed: [], blocked: [] },
  );
}

describe('profiles', () => {
  test('do not exist until something is saved', (t) => {
    const store = memoryStore(t);

    assert.equal(store.getProfile(GUILD, 'alice'), undefined);
  });

  test('keep the settings that are not part of an update', (t) => {
    const store = memoryStore(t);
    store.updateProfile(GUILD, 'alice', { name: 'Movie night', userLimit: 4 });
    store.updateProfile(GUILD, 'alice', { bitrate: 96_000 });

    assert.deepEqual(store.getProfile(GUILD, 'alice'), {
      name: 'Movie night',
      userLimit: 4,
      bitrate: 96_000,
      rtcRegion: null,
      videoQuality: null,
      privacy: null,
    });
  });

  test('can have a setting cleared back to "use the default"', (t) => {
    const store = memoryStore(t);
    store.updateProfile(GUILD, 'alice', { name: 'Movie night', rtcRegion: 'japan' });
    store.updateProfile(GUILD, 'alice', { name: null, rtcRegion: null });

    assert.equal(store.getProfile(GUILD, 'alice')?.name, null);
    assert.equal(store.getProfile(GUILD, 'alice')?.rtcRegion, null);
  });

  test('are separate for each member and each server', (t) => {
    const store = memoryStore(t);
    store.updateProfile(GUILD, 'alice', { userLimit: 4 });
    store.updateProfile(GUILD, 'bob', { userLimit: 8 });
    store.updateProfile(OTHER_GUILD, 'alice', { userLimit: 2 });

    assert.equal(store.getProfile(GUILD, 'alice')?.userLimit, 4);
    assert.equal(store.getProfile(GUILD, 'bob')?.userLimit, 8);
    assert.equal(store.getProfile(OTHER_GUILD, 'alice')?.userLimit, 2);
  });

  test('refuse a privacy mode that does not exist', (t) => {
    const store = memoryStore(t);

    assert.throws(() => store.updateProfile(GUILD, 'alice', { privacy: 'secret' as never }));
    assert.equal(store.getProfile(GUILD, 'alice'), undefined, 'a failed update leaves nothing behind');
  });
});

describe('access lists', () => {
  test('remember who is allowed and who is blocked, in the order they were added', (t) => {
    const store = memoryStore(t);
    store.changeProfileAccess(GUILD, 'alice', 'allow', ['carol', 'bob'], []);
    store.changeProfileAccess(GUILD, 'alice', 'block', ['dave'], []);

    assert.deepEqual(store.getProfileAccess(GUILD, 'alice'), { allowed: ['carol', 'bob'], blocked: ['dave'] });
  });

  test('move someone from one list to the other instead of having them on both', (t) => {
    const store = memoryStore(t);
    store.changeProfileAccess(GUILD, 'alice', 'allow', ['bob'], []);
    store.changeProfileAccess(GUILD, 'alice', 'block', ['bob'], []);

    assert.deepEqual(store.getProfileAccess(GUILD, 'alice'), { allowed: [], blocked: ['bob'] });
  });

  test('only remove someone from the list that was named', (t) => {
    const store = memoryStore(t);
    store.changeProfileAccess(GUILD, 'alice', 'block', ['bob'], []);
    store.changeProfileAccess(GUILD, 'alice', 'allow', [], ['bob']);

    assert.deepEqual(store.getProfileAccess(GUILD, 'alice'), { allowed: [], blocked: ['bob'] });
  });

  test('belong to one owner only', (t) => {
    const store = memoryStore(t);
    store.changeProfileAccess(GUILD, 'alice', 'allow', ['carol'], []);

    assert.deepEqual(store.getProfileAccess(GUILD, 'bob'), { allowed: [], blocked: [] });
    assert.deepEqual(store.getProfileAccess(OTHER_GUILD, 'alice'), { allowed: [], blocked: [] });
  });
});

describe('live channels', () => {
  test('start with a copy of the lists they were created with', (t) => {
    const store = memoryStore(t);
    store.createTempChannel(
      { channelId: 'c1', guildId: GUILD, hubId: 'hub', ownerId: 'alice', privacy: 'locked', createdAt: 5 },
      { allowed: ['bob'], blocked: ['dave'] },
    );

    assert.deepEqual(store.getTempChannel('c1'), {
      channelId: 'c1',
      guildId: GUILD,
      hubId: 'hub',
      ownerId: 'alice',
      privacy: 'locked',
      panelMessageId: null,
      createdAt: 5,
    });
    assert.deepEqual(store.getChannelAccess('c1'), { allowed: ['bob'], blocked: ['dave'] });
  });

  test('can be found by their owner, newest first', (t) => {
    const store = memoryStore(t);
    addChannel(store, 'old', 'alice', 1);
    addChannel(store, 'new', 'alice', 2);

    assert.equal(store.getTempChannelByOwner(GUILD, 'alice')?.channelId, 'new');
    assert.equal(store.getTempChannelByOwner(GUILD, 'bob'), undefined);
    assert.equal(store.getTempChannelByOwner(OTHER_GUILD, 'alice'), undefined);
  });

  test('take their lists and sanctions with them when deleted, but not the owner\'s profile', (t) => {
    const store = memoryStore(t);
    addChannel(store, 'c1', 'alice');
    store.changeChannelAccess('c1', 'allow', ['bob'], []);
    store.setSanction('c1', 'bob', { muted: true });
    store.changeProfileAccess(GUILD, 'alice', 'allow', ['bob'], []);

    assert.equal(store.deleteTempChannel('c1'), true);

    assert.equal(store.getTempChannel('c1'), undefined);
    assert.deepEqual(store.getChannelAccess('c1'), { allowed: [], blocked: [] });
    assert.deepEqual(store.listSanctions('c1'), []);
    assert.deepEqual(store.getProfileAccess(GUILD, 'alice'), { allowed: ['bob'], blocked: [] });
    assert.equal(store.deleteTempChannel('c1'), false, 'deleting twice is harmless');
  });

  test('can have their lists replaced wholesale', (t) => {
    const store = memoryStore(t);
    addChannel(store, 'c1', 'alice');
    store.changeChannelAccess('c1', 'allow', ['bob', 'carol'], []);

    store.setChannelAccess('c1', { allowed: ['dave'], blocked: ['bob'] });

    assert.deepEqual(store.getChannelAccess('c1'), { allowed: ['dave'], blocked: ['bob'] });
  });

  test('refuse lists for a channel that is not on record', (t) => {
    const store = memoryStore(t);

    assert.throws(() => store.changeChannelAccess('ghost', 'allow', ['bob'], []));
  });
});

describe('handing a channel over', () => {
  test('makes the new owner the owner and keeps the previous one allowed', (t) => {
    const store = memoryStore(t);
    addChannel(store, 'c1', 'alice');
    store.changeChannelAccess('c1', 'allow', ['bob', 'carol'], []);

    store.transferOwnership('c1', 'bob', true);

    assert.equal(store.getTempChannel('c1')?.ownerId, 'bob');
    assert.deepEqual(store.getChannelAccess('c1'), { allowed: ['carol', 'alice'], blocked: [] });
  });

  test('can leave the previous owner off the list', (t) => {
    const store = memoryStore(t);
    addChannel(store, 'c1', 'alice');

    store.transferOwnership('c1', 'bob', false);

    assert.deepEqual(store.getChannelAccess('c1'), { allowed: [], blocked: [] });
  });

  test('to the current owner changes nothing', (t) => {
    const store = memoryStore(t);
    addChannel(store, 'c1', 'alice');
    store.changeChannelAccess('c1', 'allow', ['bob'], []);

    store.transferOwnership('c1', 'alice', true);

    assert.equal(store.getTempChannel('c1')?.ownerId, 'alice');
    assert.deepEqual(store.getChannelAccess('c1'), { allowed: ['bob'], blocked: [] });
  });
});

describe('mute and deafen records', () => {
  test('track each flag on its own and disappear when both are off', (t) => {
    const store = memoryStore(t);
    addChannel(store, 'c1', 'alice');

    assert.deepEqual(store.setSanction('c1', 'bob', { muted: true }), { muted: true, deafened: false });
    assert.deepEqual(store.setSanction('c1', 'bob', { deafened: true }), { muted: true, deafened: true });
    assert.deepEqual(store.setSanction('c1', 'bob', { muted: false }), { muted: false, deafened: true });
    assert.deepEqual(store.listSanctions('c1'), [{ userId: 'bob', muted: false, deafened: true }]);

    store.setSanction('c1', 'bob', { deafened: false });
    assert.deepEqual(store.listSanctions('c1'), []);
    assert.deepEqual(store.getSanction('c1', 'bob'), { muted: false, deafened: false });
  });

  test('keep what the bot applied separately from what channels ask for', (t) => {
    const store = memoryStore(t);
    addChannel(store, 'c1', 'alice');
    store.setSanction('c1', 'bob', { muted: true });
    store.setApplied(GUILD, 'bob', { muted: true, deafened: false });

    store.deleteTempChannel('c1');

    // The channel is gone, but the bot still owes bob an unmute.
    assert.deepEqual(store.getApplied(GUILD, 'bob'), { muted: true, deafened: false });
    assert.deepEqual(store.listSanctionedUsers(GUILD), ['bob']);

    store.setApplied(GUILD, 'bob', { muted: false, deafened: false });
    assert.deepEqual(store.listSanctionedUsers(GUILD), []);
  });

  test('list everyone in a server who may need correcting, once each', (t) => {
    const store = memoryStore(t);
    addChannel(store, 'c1', 'alice');
    store.setSanction('c1', 'bob', { muted: true });
    store.setApplied(GUILD, 'bob', { muted: true, deafened: false });
    store.setApplied(GUILD, 'carol', { muted: false, deafened: true });
    store.setApplied(OTHER_GUILD, 'dave', { muted: true, deafened: false });

    assert.deepEqual(store.listSanctionedUsers(GUILD).sort(), ['bob', 'carol']);
  });
});

describe('hubs', () => {
  test('can be added, listed and removed', (t) => {
    const store = memoryStore(t);
    store.addHub(GUILD, 'h1', 1);
    store.addHub(GUILD, 'h2', 2);
    store.addHub(GUILD, 'h1', 3);

    assert.deepEqual(
      store.listHubs(GUILD).map((hub) => hub.channelId),
      ['h1', 'h2'],
    );
    assert.equal(store.getHub('h1')?.guildId, GUILD);
    assert.equal(store.removeHub('h1'), true);
    assert.equal(store.removeHub('h1'), false);
    assert.equal(store.getHub('h1'), undefined);
  });
});

function schemaVersion(file: string): number {
  const raw = new DatabaseSync(file);
  try {
    return Number((raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  } finally {
    raw.close();
  }
}

describe('the database file', () => {
  function tempFile(t: TestContext): string {
    const directory = mkdtempSync(path.join(tmpdir(), 'voice-bot-test-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    return path.join(directory, 'nested', 'bot.sqlite');
  }

  test('is created together with its folder, and keeps its contents between runs', (t) => {
    const file = tempFile(t);
    const first = new Store(openDatabase(file));
    first.updateProfile(GUILD, 'alice', { name: 'Movie night' });
    first.close();

    const second = new Store(openDatabase(file));
    t.after(() => second.close());
    assert.equal(second.getProfile(GUILD, 'alice')?.name, 'Movie night');
  });

  test('is not opened by a build older than the one that wrote it', (t) => {
    const file = tempFile(t);
    new Store(openDatabase(file)).close();
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA user_version = 999');
    raw.close();

    assert.throws(() => openDatabase(file), /newer version of the bot/u);
  });

  // Permission bits do not stop root, so these only mean something as an ordinary user,
  // which is also how the bot runs in its container.
  const isRoot = process.getuid?.() === 0;

  test('is refused at startup when it can be read but not written', { skip: isRoot && 'running as root' }, (t) => {
    // What copying a backup into the container as root leaves behind: a file the bot's
    // user may read but not change, in a folder that is its own.
    const file = tempFile(t);
    new Store(openDatabase(file)).close();
    chmodSync(file, 0o444);

    assert.throws(
      () => openDatabase(file),
      (error: unknown) =>
        error instanceof DatabaseError &&
        error.message.includes(`Cannot open the database at ${file} for writing`) &&
        /belong to the user the bot runs as/u.test(error.message),
    );
  });

  test('is refused with an explanation when its folder cannot be created', { skip: isRoot && 'running as root' }, (t) => {
    const locked = path.dirname(tempFile(t));
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o555);

    try {
      assert.throws(() => openDatabase(path.join(locked, 'deeper', 'bot.sqlite')), DatabaseError);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test('keeps its schema version when it is opened again', (t) => {
    // Checking that the file is writable rewrites the version field; it must not change it.
    const file = tempFile(t);
    new Store(openDatabase(file)).close();
    const versionAfterFirstOpen = schemaVersion(file);
    new Store(openDatabase(file)).close();

    assert.ok(versionAfterFirstOpen > 0);
    assert.equal(schemaVersion(file), versionAfterFirstOpen);
  });

  test('opens normally when it is writable', (t) => {
    const file = tempFile(t);
    new Store(openDatabase(file)).close();

    const store = new Store(openDatabase(file));
    t.after(() => store.close());
    store.addHub(GUILD, 'h1');
    assert.equal(store.listHubs(GUILD).length, 1);
  });
});
