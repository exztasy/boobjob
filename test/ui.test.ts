import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { VideoQualityMode } from 'discord.js';
import { PanelButton, SelectId, parseCustomId } from '../src/ui/ids.js';
import { renderPanel, type PanelView } from '../src/ui/panel.js';
import {
  accessPrompt,
  kickPrompt,
  limitModal,
  nameModal,
  qualityPrompt,
  sanctionPrompt,
  transferPrompt,
  type MemberOption,
  type Prompt,
} from '../src/ui/prompts.js';
import { allComponents, findComponent, optionsOf, textOf, validateMessage, validateModal, type Json } from './support/fakeDiscord.js';

/** What actually goes over the wire for a prompt, checked against Discord's limits. */
function send(prompt: Prompt): Json {
  const message = { content: prompt.content, components: prompt.components.map((row) => row.toJSON()) };
  validateMessage(message, true);
  return message;
}

function sendPanel(view: PanelView): Json {
  const panel = renderPanel(view);
  const message = { flags: panel.flags, components: panel.components.map((container) => container.toJSON()) };
  validateMessage(message, true);
  return message;
}

function view(overrides: Partial<PanelView> = {}): PanelView {
  return {
    channelName: "alice's channel",
    ownerId: '1',
    hubId: '2',
    userLimit: 0,
    bitrate: 64_000,
    rtcRegion: null,
    videoQuality: null,
    privacy: 'hidden',
    allowedCount: 0,
    blockedCount: 0,
    pendingName: null,
    ...overrides,
  };
}

function people(count: number): MemberOption[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String(1000 + index),
    name: `Member ${String(index).padStart(2, '0')}`,
    detail: `@member${index}`,
  }));
}

describe('the control panel', () => {
  test('fits Discord\'s limits even with the longest values', () => {
    const message = sendPanel(
      view({
        channelName: '🎮'.repeat(50),
        userLimit: 99,
        bitrate: 384_000,
        rtcRegion: 'south-korea',
        videoQuality: VideoQualityMode.Full,
        privacy: 'public',
        allowedCount: 25,
        blockedCount: 25,
        pendingName: { name: 'x'.repeat(100), at: Date.now() + 600_000 },
      }),
    );

    assert.ok(allComponents(message).length <= 40);
    assert.ok(textOf(message).length <= 4000);
  });

  test('has a control for everything an owner can do', () => {
    const message = sendPanel(view());

    for (const id of [
      PanelButton.Name,
      PanelButton.Limit,
      PanelButton.Quality,
      PanelButton.privacy('hidden'),
      PanelButton.privacy('locked'),
      PanelButton.privacy('public'),
      PanelButton.Allowed,
      PanelButton.Blocked,
      PanelButton.Kick,
      PanelButton.Mute,
      PanelButton.Deafen,
      PanelButton.Transfer,
      PanelButton.Claim,
    ]) {
      assert.ok(findComponent(message, id), `missing ${id}`);
      assert.ok(parseCustomId(id), `${id} must be recognised when it comes back`);
    }
  });

  test('marks the current privacy mode and only that one', () => {
    for (const privacy of ['hidden', 'locked', 'public'] as const) {
      const message = sendPanel(view({ privacy }));
      for (const mode of ['hidden', 'locked', 'public'] as const) {
        assert.equal(findComponent(message, PanelButton.privacy(mode))?.disabled, mode === privacy, `${privacy}/${mode}`);
      }
    }
  });

  test('shows the settings in words', () => {
    const text = textOf(sendPanel(view({ userLimit: 1, bitrate: 96_000, rtcRegion: 'japan', videoQuality: VideoQualityMode.Full, allowedCount: 3, blockedCount: 1 })));

    assert.match(text, /1 user\b/u);
    assert.match(text, /96 kbps/u);
    assert.match(text, /japan/u);
    assert.match(text, /720p video/u);
    assert.match(text, /3 allowed · 🚫 1 blocked/u);
  });

  test('does not let a channel name inject formatting', () => {
    const text = textOf(sendPanel(view({ channelName: '**loud** _name_ `code`' })));

    assert.ok(text.includes('\\*\\*loud\\*\\* \\_name\\_ \\`code\\`'));
  });

  test('copes with the hub having been deleted', () => {
    const text = textOf(sendPanel(view({ hubId: null })));

    assert.match(text, /the next time the owner creates a channel/u);
    assert.doesNotMatch(text, /<#/u);
  });
});

describe('the bitrate, region and video menus', () => {
  const regions = Array.from({ length: 30 }, (_, index) => ({ id: `region-${index}`, name: `Region ${index}` }));

  test('offer only bitrates the server allows, and always include the current one', () => {
    const message = send(qualityPrompt({ bitrate: 72_000, maxBitrate: 128_000, rtcRegion: null, videoQuality: null, regions: [] }));

    assert.deepEqual(
      optionsOf(message, SelectId.Bitrate).map((option) => option.value),
      ['8', '16', '32', '64', '72', '96', '128'],
    );
    assert.equal(optionsOf(message, SelectId.Bitrate).find((option) => option.default)?.value, '72');
  });

  test('never exceed 25 entries, however many regions Discord has', () => {
    const message = send(qualityPrompt({ bitrate: 64_000, maxBitrate: 96_000, rtcRegion: null, videoQuality: null, regions }));

    assert.equal(optionsOf(message, SelectId.Region).length, 25);
    assert.equal(optionsOf(message, SelectId.Region)[0]?.value, 'auto');
    assert.equal(optionsOf(message, SelectId.Region)[0]?.default, true);
  });

  test('still show the current region when it is not in the list any more', () => {
    const message = send(qualityPrompt({ bitrate: 64_000, maxBitrate: 96_000, rtcRegion: 'retired', videoQuality: null, regions }));
    const options = optionsOf(message, SelectId.Region);

    assert.equal(options.length, 25);
    assert.deepEqual(options.filter((option) => option.default).map((option) => option.value), ['retired']);
  });

  test('work when the list of regions could not be loaded', () => {
    const message = send(qualityPrompt({ bitrate: 64_000, maxBitrate: 96_000, rtcRegion: null, videoQuality: VideoQualityMode.Full, regions: [] }));

    assert.deepEqual(optionsOf(message, SelectId.Region).map((option) => option.value), ['auto']);
    assert.equal(optionsOf(message, SelectId.Video).find((option) => option.default)?.value, String(VideoQualityMode.Full));
  });
});

describe('the allow and block menus', () => {
  test('show the current list, up to the 25 a menu can hold', () => {
    const ids = Array.from({ length: 25 }, (_, index) => String(5000 + index));
    const message = send(accessPrompt('allow', '9', ids));
    const menu = findComponent(message, SelectId.Allowed)!;

    assert.equal(menu.default_values.length, 25);
    assert.equal(menu.min_values, 0, 'so that the last person can be removed');
    assert.equal(menu.max_values, 25);
  });

  test('work with an empty list', () => {
    const message = send(accessPrompt('block', '9', []));

    assert.equal(findComponent(message, SelectId.Blocked)?.default_values ?? undefined, undefined);
  });

  test('carry the outcome of the last change', () => {
    const message = send(accessPrompt('allow', '9', [], '✅ Done.'));

    assert.ok(message.content.startsWith('✅ Done.\n\n'));
  });
});

describe('the menus of people in the channel', () => {
  test('list everyone when they fit', () => {
    const message = send(kickPrompt('9', people(25)));

    assert.equal(optionsOf(message, SelectId.Kick).length, 25);
    assert.equal(findComponent(message, SelectId.Kick)?.max_values, 25);
    assert.doesNotMatch(message.content, /Showing/u);
  });

  test('show the first 25 of a crowd and point to the command for the rest', () => {
    const message = send(kickPrompt('9', people(60)));

    assert.equal(optionsOf(message, SelectId.Kick).length, 25);
    assert.match(message.content, /Showing 25 of 60 people\. Use `\/voice kick` for anyone not listed\./u);
  });

  test('have no menu when there is nobody to pick', () => {
    for (const prompt of [kickPrompt('9', []), sanctionPrompt('mute', '9', []), sanctionPrompt('deafen', '9', []), transferPrompt('9', [])]) {
      const message = send(prompt);
      assert.deepEqual(message.components, []);
      assert.match(message.content, /There is nobody else in <#9>/u);
    }
  });

  test('tick the people who are currently muted, and let all of them be unticked', () => {
    const members = people(5).map((member, index) => ({ ...member, selected: index < 2 }));
    const message = send(sanctionPrompt('mute', '9', members));
    const menu = findComponent(message, SelectId.Mute)!;

    assert.deepEqual(
      optionsOf(message, SelectId.Mute).filter((option) => option.default).map((option) => option.value),
      ['1000', '1001'],
    );
    assert.equal(menu.min_values, 0);
    assert.equal(menu.max_values, 5);
  });

  test('let exactly one person be picked as the new owner', () => {
    const menu = findComponent(send(transferPrompt('9', people(3))), SelectId.Transfer)!;

    assert.equal(menu.min_values, 1);
    assert.equal(menu.max_values, 1);
  });

  test('cope with very long and empty display names', () => {
    const message = send(
      kickPrompt('9', [
        { id: '1', name: '名'.repeat(200), detail: 'd'.repeat(300) },
        { id: '2', name: '' },
      ]),
    );
    const [long, empty] = optionsOf(message, SelectId.Kick);

    assert.ok(long!.label.length <= 100);
    assert.ok(long!.description.length <= 100);
    assert.equal(empty!.label, '2', 'falls back to the id rather than an empty label');
  });
});

describe('the forms', () => {
  test('start out filled in with the current value', () => {
    const name = nameModal('Movie night').toJSON() as Json;
    const limit = limitModal(4).toJSON() as Json;
    validateModal(name);
    validateModal(limit);

    assert.equal(name.components[0].component.value, 'Movie night');
    assert.equal(name.components[0].component.required, false, 'an empty name means "back to the default"');
    assert.equal(limit.components[0].component.value, '4');
  });

  test('accept the longest name Discord allows', () => {
    validateModal(nameModal('n'.repeat(100)).toJSON() as Json);
    validateModal(nameModal('🎮'.repeat(50)).toJSON() as Json);
  });
});

test('custom ids of other bots and of malformed input are ignored', () => {
  assert.equal(parseCustomId('other:name'), null);
  assert.equal(parseCustomId('vc'), null);
  assert.equal(parseCustomId(''), null);
  assert.deepEqual(parseCustomId('vc:privacy:locked'), { action: 'privacy', argument: 'locked' });
  assert.deepEqual(parseCustomId('vc:kick'), { action: 'kick', argument: undefined });
});
