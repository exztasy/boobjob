import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { OverwriteType, PermissionFlagsBits as P } from 'discord.js';
import {
  ACCESS,
  BOT_CHANNEL_PERMISSIONS,
  MAX_OVERWRITES,
  buildOverwrites,
  type Overwrite,
  type OverwriteInput,
} from '../src/domain/overwrites.js';
import { resolvePermissions } from './support/fakeDiscord.js';

const EVERYONE = '1';
const BOT = '2';
const OWNER = '3';
const FRIEND = '4';
const STRANGER = '5';
const MEMBER_ROLE = '10';
const MUTED_ROLE = '11';
const MODERATOR_ROLE = '12';

/** What a typical @everyone role grants server-wide. */
const BASE = P.ViewChannel | P.Connect | P.Speak | P.SendMessages;

function input(overrides: Partial<OverwriteInput> = {}): OverwriteInput {
  return {
    everyoneId: EVERYONE,
    botId: BOT,
    botPermissions: P.Administrator,
    base: [],
    ownerId: OWNER,
    privacy: 'hidden',
    allowed: [],
    blocked: [],
    ...overrides,
  };
}

function role(id: string, allow = 0n, deny = 0n): Overwrite {
  return { id, type: OverwriteType.Role, allow, deny };
}

/** What a member ends up being able to do, worked out independently of the code under test. */
function permissionsOf(overwrites: Overwrite[], userId: string, roleIds: string[] = [], base = BASE): bigint {
  return resolvePermissions({ base, userId, roleIds, everyoneId: EVERYONE, overwrites });
}

function canSee(overwrites: Overwrite[], userId: string, roleIds: string[] = [], base = BASE): boolean {
  return (permissionsOf(overwrites, userId, roleIds, base) & P.ViewChannel) !== 0n;
}

function canJoin(overwrites: Overwrite[], userId: string, roleIds: string[] = [], base = BASE): boolean {
  return (permissionsOf(overwrites, userId, roleIds, base) & ACCESS) === ACCESS;
}

describe('hidden channels', () => {
  test('are invisible and closed to everyone but the owner', () => {
    const overwrites = buildOverwrites(input());

    assert.ok(canJoin(overwrites, OWNER));
    assert.ok(!canSee(overwrites, STRANGER));
    assert.ok(!canJoin(overwrites, STRANGER));
  });

  test('stay hidden from roles the category shows its channels to', () => {
    // A common setup: the category is hidden from @everyone and opened up to a member role.
    const overwrites = buildOverwrites(
      input({ base: [role(EVERYONE, 0n, P.ViewChannel), role(MEMBER_ROLE, ACCESS)] }),
    );

    assert.ok(!canSee(overwrites, STRANGER, [MEMBER_ROLE]));
    assert.ok(!canJoin(overwrites, STRANGER, [MEMBER_ROLE]));
    assert.ok(canJoin(overwrites, OWNER, [MEMBER_ROLE]));
  });

  test('let allowed users in and nobody else', () => {
    const overwrites = buildOverwrites(input({ allowed: [FRIEND] }));

    assert.ok(canJoin(overwrites, FRIEND));
    assert.ok(!canSee(overwrites, STRANGER));
  });

  test('never lock the bot out of the channel it has to manage', () => {
    const overwrites = buildOverwrites(input({ botPermissions: BOT_CHANNEL_PERMISSIONS | P.ManageRoles }));
    const bot = permissionsOf(overwrites, BOT, [], BOT_CHANNEL_PERMISSIONS | P.ManageRoles);

    assert.equal(bot & BOT_CHANNEL_PERMISSIONS, BOT_CHANNEL_PERMISSIONS);
  });

  test('keep the bot in even when the category denies its role access', () => {
    const botRole = '20';
    const overwrites = buildOverwrites(input({ base: [role(botRole, 0n, ACCESS | P.SendMessages)] }));

    const bot = permissionsOf(overwrites, BOT, [botRole]);
    assert.equal(bot & (ACCESS | P.SendMessages), ACCESS | P.SendMessages);
  });
});

describe('locked channels', () => {
  test('are visible but can only be joined by the owner and allowed users', () => {
    const overwrites = buildOverwrites(input({ privacy: 'locked', allowed: [FRIEND] }));

    assert.ok(canSee(overwrites, STRANGER));
    assert.ok(!canJoin(overwrites, STRANGER));
    assert.ok(canJoin(overwrites, FRIEND));
    assert.ok(canJoin(overwrites, OWNER));
  });

  test('cannot be joined through a role the category lets connect', () => {
    const overwrites = buildOverwrites(input({ privacy: 'locked', base: [role(MEMBER_ROLE, ACCESS)] }));

    assert.ok(canSee(overwrites, STRANGER, [MEMBER_ROLE]));
    assert.ok(!canJoin(overwrites, STRANGER, [MEMBER_ROLE]));
  });

  test('are not shown to people the category is hidden from', () => {
    const overwrites = buildOverwrites(
      input({ privacy: 'locked', base: [role(EVERYONE, 0n, P.ViewChannel), role(MEMBER_ROLE, P.ViewChannel)] }),
    );

    assert.ok(!canSee(overwrites, STRANGER));
    assert.ok(canSee(overwrites, STRANGER, [MEMBER_ROLE]));
  });
});

describe('public channels', () => {
  test('are open to anyone the category is open to', () => {
    const overwrites = buildOverwrites(input({ privacy: 'public' }));

    assert.ok(canJoin(overwrites, STRANGER));
  });

  test('respect a category that is only open to one role', () => {
    const overwrites = buildOverwrites(
      input({ privacy: 'public', base: [role(EVERYONE, 0n, P.ViewChannel), role(MEMBER_ROLE, P.ViewChannel)] }),
    );

    assert.ok(!canSee(overwrites, STRANGER), 'someone without the role still cannot see it');
    assert.ok(canJoin(overwrites, STRANGER, [MEMBER_ROLE]));
  });

  test('still keep blocked users out, whatever roles they have', () => {
    const overwrites = buildOverwrites(input({ privacy: 'public', base: [role(MEMBER_ROLE, ACCESS)], blocked: [STRANGER] }));

    assert.ok(!canSee(overwrites, STRANGER, [MEMBER_ROLE]));
    assert.ok(!canJoin(overwrites, STRANGER, [MEMBER_ROLE]));
    assert.ok(canJoin(overwrites, FRIEND, [MEMBER_ROLE]));
  });
});

describe('what the channel inherits from its category', () => {
  test('restrictions such as a mute role keep working in every privacy mode', () => {
    for (const privacy of ['hidden', 'locked', 'public'] as const) {
      const overwrites = buildOverwrites(
        input({ privacy, allowed: [FRIEND], base: [role(MUTED_ROLE, 0n, P.Speak | P.SendMessages)] }),
      );
      const friend = permissionsOf(overwrites, FRIEND, [MUTED_ROLE]);

      assert.equal(friend & ACCESS, ACCESS, `${privacy}: an allowed user gets in`);
      assert.equal(friend & (P.Speak | P.SendMessages), 0n, `${privacy}: but stays muted`);
    }
  });

  test('extra permissions a role has in the category carry over', () => {
    const overwrites = buildOverwrites(
      input({ privacy: 'public', base: [role(MODERATOR_ROLE, P.MoveMembers | P.ManageMessages)] }),
    );
    const moderator = permissionsOf(overwrites, STRANGER, [MODERATOR_ROLE]);

    assert.equal(moderator & (P.MoveMembers | P.ManageMessages), P.MoveMembers | P.ManageMessages);
  });

  test('a person the category singles out is still subject to the privacy mode', () => {
    const base: Overwrite[] = [{ id: STRANGER, type: OverwriteType.Member, allow: ACCESS | P.Speak, deny: 0n }];
    const overwrites = buildOverwrites(input({ base }));

    assert.ok(!canSee(overwrites, STRANGER));
    assert.notEqual(permissionsOf(overwrites, STRANGER) & P.Speak, 0n, 'unrelated permissions are left alone');
  });
});

describe('the allow and block lists', () => {
  test('blocking wins when someone is on both lists', () => {
    const overwrites = buildOverwrites(input({ allowed: [FRIEND], blocked: [FRIEND] }));

    assert.ok(!canSee(overwrites, FRIEND));
  });

  test('the owner and the bot cannot be blocked', () => {
    const overwrites = buildOverwrites(input({ blocked: [OWNER, BOT] }));

    assert.ok(canJoin(overwrites, OWNER));
    assert.ok(canJoin(overwrites, BOT));
  });

  test('an allowed user gets in even if a role of theirs is kept out of the category', () => {
    const overwrites = buildOverwrites(input({ allowed: [FRIEND], base: [role(MEMBER_ROLE, 0n, ACCESS)] }));

    assert.ok(canJoin(overwrites, FRIEND, [MEMBER_ROLE]));
  });

  test('listing someone twice produces one overwrite', () => {
    const overwrites = buildOverwrites(input({ allowed: [FRIEND, FRIEND] }));

    assert.equal(overwrites.filter((overwrite) => overwrite.id === FRIEND).length, 1);
  });
});

describe('a bot without the Administrator permission', () => {
  const limited = BOT_CHANNEL_PERMISSIONS | P.ManageRoles;

  test('only ever sets permissions it holds itself, which is all Discord accepts', () => {
    const base = [
      role(EVERYONE, 0n, P.MentionEveryone | P.SendTTSMessages),
      role(MODERATOR_ROLE, P.ManageMessages | P.ManageRoles | P.MoveMembers),
      role(MUTED_ROLE, 0n, P.Speak | P.SendMessages),
    ];
    const overwrites = buildOverwrites(input({ botPermissions: limited, base, allowed: [FRIEND], blocked: [STRANGER] }));

    for (const overwrite of overwrites) {
      const touched = overwrite.allow | overwrite.deny;
      assert.equal(touched & ~limited, 0n, `overwrite for ${overwrite.id} touches a permission the bot lacks`);
      assert.equal(touched & P.ManageRoles, 0n, 'only administrators may set Manage Roles in an overwrite');
    }
    assert.ok(!canSee(overwrites, 'someone-else'), 'the channel is still hidden');
    assert.ok(canJoin(overwrites, FRIEND));
    assert.ok(!canSee(overwrites, STRANGER));
  });

  test('keeps the parts of inherited overwrites that it is able to set', () => {
    const base = [role(MODERATOR_ROLE, P.ManageMessages | P.MoveMembers), role(MUTED_ROLE, 0n, P.Speak | P.SendMessages)];
    const overwrites = buildOverwrites(input({ botPermissions: limited, privacy: 'public', base }));

    const moderator = overwrites.find((overwrite) => overwrite.id === MODERATOR_ROLE);
    const muted = overwrites.find((overwrite) => overwrite.id === MUTED_ROLE);
    assert.equal(moderator?.allow, P.MoveMembers, 'Manage Messages is dropped, Move Members is kept');
    assert.equal(muted?.deny, P.SendMessages, 'the bot has Send Messages but not Speak');
  });

  test('an administrator bot copies inherited overwrites exactly', () => {
    const base = [role(MODERATOR_ROLE, P.ManageMessages | P.ManageRoles), role(MUTED_ROLE, 0n, P.Speak)];
    const overwrites = buildOverwrites(input({ privacy: 'public', base }));

    assert.deepEqual(
      overwrites.filter((overwrite) => overwrite.id === MODERATOR_ROLE || overwrite.id === MUTED_ROLE),
      base,
    );
  });
});

describe('the cap of 100 overwrites per channel', () => {
  test('is never exceeded, and what keeps people out is kept before what lets people in', () => {
    const manyRoles = Array.from({ length: 80 }, (_, index) => role(`role-${index}`, 0n, P.Speak));
    const allowed = Array.from({ length: 25 }, (_, index) => `allowed-${index}`);
    const blocked = Array.from({ length: 5 }, (_, index) => `blocked-${index}`);
    const overwrites = buildOverwrites(input({ base: manyRoles, allowed, blocked }));
    const ids = new Set(overwrites.map((overwrite) => overwrite.id));

    assert.equal(overwrites.length, MAX_OVERWRITES);
    for (const id of [EVERYONE, BOT, OWNER, ...blocked, ...manyRoles.map((overwrite) => overwrite.id)]) {
      assert.ok(ids.has(id), `${id} must survive the cut`);
    }
    assert.equal(allowed.filter((id) => ids.has(id)).length, 12, 'only as many allowed users as still fit');
  });
});

test('overwrites that would not change anything are left out', () => {
  const overwrites = buildOverwrites(input({ privacy: 'public', base: [role(MEMBER_ROLE)] }));

  assert.deepEqual(overwrites.map((overwrite) => overwrite.id).sort(), [BOT, OWNER].sort());
});

test('the input is not modified', () => {
  const base = [role(MEMBER_ROLE, ACCESS)];
  buildOverwrites(input({ base }));

  assert.deepEqual(base, [role(MEMBER_ROLE, ACCESS)]);
});
