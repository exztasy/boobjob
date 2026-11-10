/**
 * A small stand-in for Discord, for driving the real bot in tests.
 *
 * It speaks enough of the gateway protocol for discord.js to log in and stay
 * connected, answers the REST calls the bot makes, and keeps the state a real
 * server would: channels, members, voice states and messages. Like the real
 * thing it sends gateway events for every change, and it refuses requests
 * Discord would refuse: missing permissions, malformed messages and
 * components, voice changes for members who are not connected, and so on.
 */
import type { AddressInfo } from 'node:net';
import { PermissionFlagsBits as P } from 'discord.js';
import { WebSocketServer, type WebSocket } from 'ws';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = Record<string, any>;

const API_PREFIX = '/api/v10';
const ALL_PERMISSIONS = (1n << 60n) - 1n;
const EPHEMERAL = 1 << 6;
const COMPONENTS_V2 = 1 << 15;

const ChannelKind = { Text: 0, Voice: 2, Category: 4 } as const;
const OverwriteKind = { Role: 0, Member: 1 } as const;
const Component = {
  ActionRow: 1,
  Button: 2,
  StringSelect: 3,
  TextInput: 4,
  UserSelect: 5,
  RoleSelect: 6,
  MentionableSelect: 7,
  ChannelSelect: 8,
  Section: 9,
  TextDisplay: 10,
  MediaGallery: 12,
  File: 13,
  Separator: 14,
  Container: 17,
  Label: 18,
} as const;
const Callback = { Reply: 4, DeferredReply: 5, DeferredUpdate: 6, Update: 7, Autocomplete: 8, Modal: 9 } as const;

export const ErrorCode = {
  UnknownChannel: 10003,
  UnknownMember: 10007,
  UnknownMessage: 10008,
  NotConnectedToVoice: 40032,
  AlreadyAcknowledged: 40060,
  MissingAccess: 50001,
  MissingPermissions: 50013,
  InvalidFormBody: 50035,
} as const;

export const VOICE_REGIONS = [
  { id: 'us-east', name: 'US East', custom: false, deprecated: false, optimal: true },
  { id: 'rotterdam', name: 'Rotterdam', custom: false, deprecated: false, optimal: false },
  { id: 'japan', name: 'Japan', custom: false, deprecated: false, optimal: false },
  { id: 'amsterdam', name: 'Amsterdam', custom: false, deprecated: true, optimal: false },
];

export interface RecordedRequest {
  method: string;
  path: string;
  body: Json | undefined;
  reason: string | undefined;
  status: number;
}

/** One interaction sent to the bot, and what the bot did with it. */
export interface InteractionResult {
  id: string;
  /** The bot's first response: its callback type and payload. */
  callback: { type: number; data: Json | undefined } | null;
  /** The message the interaction created or updated, if any. */
  message: Json | null;
  /** The modal the bot opened, if any. */
  modal: Json | null;
  /** Autocomplete suggestions, if that is what was asked for. */
  choices: Json[] | null;
  followUps: Json[];
}

interface PendingInteraction extends InteractionResult {
  token: string;
  channelId: string;
  source: Json | null;
  finish: () => void;
  finished: Promise<void>;
}

export interface FakeDiscordOptions {
  /** Server-wide permissions of the bot's role. */
  botPermissions: bigint;
  /** Server-wide permissions of @everyone. */
  everyonePermissions?: bigint;
  /** Highest bitrate the server allows, as on an unboosted server by default. */
  maxBitrate?: number;
  /** Renames allowed per channel per window before answering 429, like the real limit of 2 per 10 minutes. */
  renameLimit?: { count: number; windowMs: number; retryAfterSeconds: number };
}

export interface ChannelOptions {
  parent?: string | null;
  overwrites?: OverwriteInit[];
  bitrate?: number;
  userLimit?: number;
}

export interface OverwriteInit {
  id: string;
  type: 'role' | 'member';
  allow?: bigint;
  deny?: bigint;
}

const DEFAULT_EVERYONE =
  P.ViewChannel | P.Connect | P.Speak | P.Stream | P.UseVAD | P.SendMessages | P.ReadMessageHistory | P.EmbedLinks;

export class FakeDiscord {
  readonly guildId = '100000000000000000';
  readonly ownerId = '100000000000000001';
  readonly botId = '900000000000000000';
  readonly botRoleId = '100000000000000002';
  readonly roles = new Map<string, Json>();
  readonly channels = new Map<string, Json>();
  readonly members = new Map<string, Json>();
  readonly voice = new Map<string, { channel_id: string | null; mute: boolean; deaf: boolean }>();
  readonly messages = new Map<string, Json>();
  readonly requests: RecordedRequest[] = [];
  /** Requests the fake has no answer for. A test that ends with entries here is exercising something untested. */
  readonly unexpected: string[] = [];
  /** Payloads the fake rejected as malformed, with the reason. */
  readonly rejected: string[] = [];
  commands: Json[] = [];

  private readonly options: Required<Omit<FakeDiscordOptions, 'renameLimit'>> & Pick<FakeDiscordOptions, 'renameLimit'>;
  private readonly failures: { method: string; path: RegExp; status: number; body: Json }[] = [];
  private readonly interactions = new Map<string, PendingInteraction>();
  private readonly renames = new Map<string, number[]>();
  private server: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private sequence = 0;
  private lastId = 200000000000000000n;

  constructor(options: FakeDiscordOptions) {
    this.options = {
      everyonePermissions: DEFAULT_EVERYONE,
      maxBitrate: 96_000,
      ...options,
    };
    this.roles.set(this.guildId, this.rolePayload(this.guildId, '@everyone', this.options.everyonePermissions, 0));
    this.roles.set(this.botRoleId, this.rolePayload(this.botRoleId, 'Voice Bot', this.options.botPermissions, 1));
    this.members.set(this.ownerId, this.memberPayload(this.userPayload(this.ownerId, 'server-owner'), []));
    this.members.set(this.botId, this.memberPayload(this.userPayload(this.botId, 'voicebot', true), [this.botRoleId]));
  }

  // ── building the server ───────────────────────────────────────────────

  addRole(name: string, permissions = 0n): string {
    const id = this.nextId();
    this.roles.set(id, this.rolePayload(id, name, permissions, this.roles.size));
    return id;
  }

  addUser(username: string, options: { bot?: boolean; roles?: string[] } = {}): string {
    const id = this.nextId();
    this.members.set(id, this.memberPayload(this.userPayload(id, username, options.bot), options.roles ?? []));
    return id;
  }

  addCategory(name: string, overwrites: OverwriteInit[] = []): string {
    return this.addChannel(ChannelKind.Category, name, { overwrites });
  }

  addVoiceChannel(name: string, options: ChannelOptions = {}): string {
    return this.addChannel(ChannelKind.Voice, name, options);
  }

  addTextChannel(name: string, options: ChannelOptions = {}): string {
    return this.addChannel(ChannelKind.Text, name, options);
  }

  private addChannel(type: number, name: string, options: ChannelOptions): string {
    const id = this.nextId();
    const parent = options.parent ? this.channels.get(options.parent) : undefined;
    const overwrites = options.overwrites
      ? options.overwrites.map(toOverwritePayload)
      : clone(parent?.permission_overwrites ?? []);
    this.channels.set(id, this.channelPayload(id, type, name, options.parent ?? null, overwrites, options));
    if (this.socket) this.dispatch('CHANNEL_CREATE', this.channels.get(id)!);
    return id;
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  async start(): Promise<void> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    this.server = server;
    await new Promise<void>((resolve) => server.once('listening', resolve));

    server.on('connection', (socket) => {
      this.socket = socket;
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
      socket.on('message', (raw) => {
        const packet = JSON.parse(String(raw)) as { op: number };
        if (packet.op === 1) socket.send(JSON.stringify({ op: 11 }));
        if (packet.op === 2) this.identify();
      });
      socket.on('close', () => {
        if (this.socket === socket) this.socket = null;
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private get gatewayUrl(): string {
    const address = this.server?.address() as AddressInfo | null;
    if (!address) throw new Error('The fake gateway is not running');
    return `ws://127.0.0.1:${address.port}`;
  }

  private identify(): void {
    this.sequence = 0;
    this.dispatch('READY', {
      v: 10,
      user: this.members.get(this.botId)!.user,
      guilds: [{ id: this.guildId, unavailable: true }],
      session_id: 'fake-session',
      resume_gateway_url: this.gatewayUrl,
      shard: [0, 1],
      application: { id: this.botId, flags: 0 },
    });
    this.dispatch('GUILD_CREATE', this.guildPayload());
  }

  private dispatch(type: string, data: Json): void {
    this.socket?.send(JSON.stringify({ op: 0, t: type, s: ++this.sequence, d: data }));
  }

  // ── what people do ────────────────────────────────────────────────────

  /** A member joins, or moves to, a voice channel. */
  join(userId: string, channelId: string): void {
    this.requireMember(userId);
    if (!this.channels.has(channelId)) throw new Error(`No channel ${channelId} to join`);
    this.changeVoice(userId, { channel_id: channelId });
  }

  /** A member disconnects from voice. */
  leave(userId: string): void {
    this.changeVoice(userId, { channel_id: null });
  }

  /** A moderator server-mutes or -deafens a member by hand. Like the API, this needs them to be connected. */
  moderate(userId: string, change: { mute?: boolean; deaf?: boolean }): void {
    if (!this.voiceOf(userId).channel_id) throw new Error('Discord refuses voice changes for members who are not connected');
    this.changeVoice(userId, change);
  }

  /** Someone with the permission to do so edits a channel in Discord's own settings. */
  editChannelByHand(channelId: string, change: Json): void {
    const channel = this.requireChannel(channelId);
    Object.assign(channel, change);
    this.dispatch('CHANNEL_UPDATE', channel);
  }

  deleteChannelByHand(channelId: string): void {
    this.removeChannel(this.requireChannel(channelId));
  }

  deleteMessageByHand(messageId: string): void {
    this.messages.delete(messageId);
  }

  channelOf(userId: string): string | null {
    return this.voiceOf(userId).channel_id;
  }

  voiceOf(userId: string): { channel_id: string | null; mute: boolean; deaf: boolean } {
    let state = this.voice.get(userId);
    if (!state) {
      state = { channel_id: null, mute: false, deaf: false };
      this.voice.set(userId, state);
    }
    return state;
  }

  membersIn(channelId: string): string[] {
    return [...this.voice].filter(([, state]) => state.channel_id === channelId).map(([userId]) => userId);
  }

  private changeVoice(userId: string, change: Partial<{ channel_id: string | null; mute: boolean; deaf: boolean }>): void {
    Object.assign(this.voiceOf(userId), change);
    this.dispatch('VOICE_STATE_UPDATE', this.voicePayload(userId));
  }

  // ── permissions, computed the way Discord documents it ───────────────

  guildPermissions(userId: string): bigint {
    if (userId === this.ownerId) return ALL_PERMISSIONS;
    const member = this.requireMember(userId);
    let permissions = BigInt(this.roles.get(this.guildId)!.permissions);
    for (const roleId of member.roles as string[]) permissions |= BigInt(this.roles.get(roleId)?.permissions ?? 0);
    return (permissions & P.Administrator) !== 0n ? ALL_PERMISSIONS : permissions;
  }

  permissionsIn(userId: string, channelId: string): bigint {
    const base = this.guildPermissions(userId);
    if (base === ALL_PERMISSIONS) return base;
    return resolvePermissions({
      base,
      userId,
      roleIds: this.requireMember(userId).roles as string[],
      everyoneId: this.guildId,
      overwrites: this.requireChannel(channelId).permission_overwrites as PermissionQuestion['overwrites'],
    });
  }

  can(userId: string, channelId: string, permission: bigint): boolean {
    return (this.permissionsIn(userId, channelId) & permission) === permission;
  }

  canSee(userId: string, channelId: string): boolean {
    return this.can(userId, channelId, P.ViewChannel);
  }

  /** Whether a member could connect to a voice channel themselves. */
  canJoin(userId: string, channelId: string): boolean {
    return this.can(userId, channelId, P.ViewChannel | P.Connect);
  }

  // ── messages ──────────────────────────────────────────────────────────

  /** Messages in a channel that everyone there can see, oldest first. */
  messagesIn(channelId: string): Json[] {
    return [...this.messages.values()].filter(
      (message) => message.channel_id === channelId && (message.flags & EPHEMERAL) === 0,
    );
  }

  /** The control panel in a channel: the latest components-only message. */
  panelIn(channelId: string): Json | undefined {
    return this.messagesIn(channelId)
      .filter((message) => (message.flags & COMPONENTS_V2) !== 0)
      .at(-1);
  }

  // ── failure injection ─────────────────────────────────────────────────

  /** Makes the next matching request fail the given way. */
  failNext(method: string, path: RegExp, status: number, body: Json): void {
    this.failures.push({ method, path, status, body });
  }

  requestsTo(method: string, path: RegExp): RecordedRequest[] {
    return this.requests.filter((request) => request.method === method && path.test(request.path));
  }

  // ── interactions ──────────────────────────────────────────────────────

  /** A member presses a button on a message. */
  click(userId: string, message: Json, customId: string): Promise<InteractionResult> {
    const button = findComponent(message, customId);
    if (!button || button.type !== Component.Button) throw new Error(`No button "${customId}" on that message`);
    if (button.disabled) throw new Error(`Button "${customId}" is disabled and cannot be pressed`);
    return this.interact(userId, message.channel_id, 3, { custom_id: customId, component_type: Component.Button }, message);
  }

  /** A member picks entries in a text select menu. */
  choose(userId: string, message: Json, customId: string, values: string[]): Promise<InteractionResult> {
    const menu = findComponent(message, customId);
    if (!menu || menu.type !== Component.StringSelect) throw new Error(`No select menu "${customId}" on that message`);
    const offered = new Set((menu.options as Json[]).map((option) => option.value));
    for (const value of values) {
      if (!offered.has(value)) throw new Error(`"${value}" is not an option of menu "${customId}"`);
    }
    assertSelectionSize(menu, values.length);
    return this.interact(
      userId,
      message.channel_id,
      3,
      { custom_id: customId, component_type: Component.StringSelect, values },
      message,
    );
  }

  /** A member picks people in a user select menu. */
  chooseUsers(userId: string, message: Json, customId: string, userIds: string[]): Promise<InteractionResult> {
    const menu = findComponent(message, customId);
    if (!menu || menu.type !== Component.UserSelect) throw new Error(`No user select menu "${customId}" on that message`);
    assertSelectionSize(menu, userIds.length);
    return this.interact(
      userId,
      message.channel_id,
      3,
      { custom_id: customId, component_type: Component.UserSelect, values: userIds, resolved: this.resolveUsers(userIds) },
      message,
    );
  }

  /** A member fills in and submits a modal the bot opened. */
  submit(userId: string, channelId: string, modal: Json, values: Record<string, string>): Promise<InteractionResult> {
    const components = (modal.components as Json[]).map((label) => {
      const input = label.component as Json;
      const value = values[input.custom_id] ?? input.value ?? '';
      if (input.required !== false && value === '') throw new Error(`"${input.custom_id}" is required`);
      if (input.max_length !== undefined && value.length > input.max_length) {
        throw new Error(`"${input.custom_id}" takes at most ${input.max_length} characters`);
      }
      return { type: Component.Label, component: { type: Component.TextInput, custom_id: input.custom_id, value } };
    });
    return this.interact(userId, channelId, 5, { custom_id: modal.custom_id, components });
  }

  /** A member runs a slash command. Options are given by name. */
  command(
    userId: string,
    channelId: string,
    name: string,
    subcommand: string,
    options: Record<string, string | number | { user: string } | { channel: string }> = {},
  ): Promise<InteractionResult> {
    const definition = this.commands.find((command) => command.name === name);
    const subDefinition = (definition?.options as Json[] | undefined)?.find((option) => option.name === subcommand);
    if (!definition || !subDefinition) throw new Error(`The bot has not registered /${name} ${subcommand}`);

    const resolved: Json = {};
    const given = Object.entries(options).map(([optionName, value]) => {
      const optionDefinition = (subDefinition.options as Json[] | undefined)?.find((option) => option.name === optionName);
      if (!optionDefinition) throw new Error(`/${name} ${subcommand} has no option "${optionName}"`);
      if (typeof value === 'object' && 'user' in value) {
        Object.assign((resolved.users ??= {}), this.resolveUsers([value.user]).users);
        Object.assign((resolved.members ??= {}), this.resolveUsers([value.user]).members);
        return { name: optionName, type: 6, value: value.user };
      }
      if (typeof value === 'object') {
        const channel = this.requireChannel(value.channel);
        (resolved.channels ??= {})[channel.id] = {
          id: channel.id,
          name: channel.name,
          type: channel.type,
          parent_id: channel.parent_id,
          permissions: String(this.permissionsIn(userId, channel.id)),
        };
        return { name: optionName, type: 7, value: value.channel };
      }
      return { name: optionName, type: optionDefinition.type, value };
    });
    for (const option of (subDefinition.options as Json[] | undefined) ?? []) {
      if (option.required && !(option.name in options)) throw new Error(`/${name} ${subcommand} requires "${option.name}"`);
    }

    return this.interact(userId, channelId, 2, {
      id: definition.id,
      name,
      type: 1,
      options: [{ name: subcommand, type: 1, options: given }],
      resolved,
    });
  }

  /** A member is typing into an autocompleted option of a slash command. */
  autocomplete(
    userId: string,
    channelId: string,
    name: string,
    subcommand: string,
    option: string,
    typed: string,
  ): Promise<InteractionResult> {
    const definition = this.commands.find((command) => command.name === name);
    if (!definition) throw new Error(`The bot has not registered /${name}`);
    return this.interact(userId, channelId, 4, {
      id: definition.id,
      name,
      type: 1,
      options: [{ name: subcommand, type: 1, options: [{ name: option, type: 3, value: typed, focused: true }] }],
    });
  }

  private async interact(
    userId: string,
    channelId: string,
    type: number,
    data: Json,
    message?: Json,
  ): Promise<InteractionResult> {
    const member = this.requireMember(userId);
    const channel = this.requireChannel(channelId);
    const id = this.nextId();
    const token = `interaction-token-${id}`;

    let finish: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending: PendingInteraction = {
      id,
      token,
      channelId,
      source: message ? (this.messages.get(message.id) ?? null) : null,
      callback: null,
      message: null,
      modal: null,
      choices: null,
      followUps: [],
      finish,
      finished,
    };
    this.interactions.set(token, pending);

    this.dispatch('INTERACTION_CREATE', {
      id,
      application_id: this.botId,
      type,
      token,
      version: 1,
      guild_id: this.guildId,
      guild: { id: this.guildId, locale: 'en-US', features: [] },
      channel_id: channelId,
      channel,
      member: { ...member, permissions: String(this.permissionsIn(userId, channelId)) },
      locale: 'en-US',
      guild_locale: 'en-US',
      app_permissions: String(this.permissionsIn(this.botId, channelId)),
      entitlements: [],
      authorizing_integration_owners: { '0': this.guildId },
      context: 0,
      attachment_size_limit: 10_485_760,
      data,
      ...(message ? { message } : {}),
    });

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`The bot did not finish answering interaction ${id} (${describe(data)})`)), 5_000);
    });
    try {
      await Promise.race([finished, timeout]);
    } finally {
      clearTimeout(timer);
    }
    const { callback, modal, choices, followUps } = pending;
    return { id, callback, message: pending.message, modal, choices, followUps };
  }

  private resolveUsers(userIds: string[]): { users: Json; members: Json } {
    const users: Json = {};
    const members: Json = {};
    for (const userId of userIds) {
      const member = this.requireMember(userId);
      users[userId] = member.user;
      const { user: _user, ...rest } = member;
      members[userId] = { ...rest, permissions: String(this.guildPermissions(userId)) };
    }
    return { users, members };
  }

  // ── REST ──────────────────────────────────────────────────────────────

  /** Plug this into the client as `rest.makeRequest`. */
  readonly makeRequest = async (url: string, init: { method?: string; body?: unknown; headers?: unknown }): Promise<Response> => {
    const { pathname } = new URL(url);
    const decoded = decodeURIComponent(pathname);
    const path = decoded.startsWith(API_PREFIX) ? decoded.slice(API_PREFIX.length) : decoded;
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Json) : undefined;
    const reason = readHeader(init.headers, 'x-audit-log-reason');

    const forced = this.failures.findIndex((failure) => failure.method === method && failure.path.test(path));
    let response: Reply;
    if (forced >= 0) {
      const [failure] = this.failures.splice(forced, 1);
      response = { status: failure!.status, body: failure!.body };
    } else {
      try {
        response = this.route(method, path, body);
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (error.code === ErrorCode.InvalidFormBody) this.rejected.push(`${method} ${path}: ${error.message}`);
        response = { status: error.status, body: { code: error.code, message: error.message }, headers: error.headers };
      }
    }

    this.requests.push({ method, path, body, reason: reason ? decodeURIComponent(reason) : undefined, status: response.status });
    if (response.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status,
      headers: { 'content-type': 'application/json', ...response.headers },
    });
  };

  private route(method: string, path: string, body: Json | undefined): Reply {
    let match: RegExpMatchArray | null;

    if (method === 'GET' && path === '/gateway/bot') {
      return ok({
        url: this.gatewayUrl,
        shards: 1,
        session_start_limit: { total: 1000, remaining: 999, reset_after: 14_400_000, max_concurrency: 1 },
      });
    }
    if (method === 'PUT' && /^\/applications\/\d+\/commands$/u.test(path)) {
      for (const command of body as unknown as Json[]) validateCommand(command);
      this.commands = (body as unknown as Json[]).map((command) => ({ ...command, id: this.nextId(), application_id: this.botId }));
      return ok(this.commands);
    }
    if (method === 'GET' && path === '/voice/regions') return ok(VOICE_REGIONS);

    if (method === 'POST' && /^\/guilds\/\d+\/channels$/u.test(path)) return ok(this.createChannel(body ?? {}), 201);

    if ((match = path.match(/^\/channels\/(\d+)$/u))) {
      const channel = this.channels.get(match[1]!);
      if (!channel) throw new ApiError(404, ErrorCode.UnknownChannel, 'Unknown Channel');
      if (method === 'GET') return ok(channel);
      if (method === 'PATCH') return ok(this.modifyChannel(channel, body ?? {}));
      if (method === 'DELETE') {
        this.requireManageable(channel);
        this.removeChannel(channel);
        return ok(channel);
      }
    }

    if ((match = path.match(/^\/guilds\/\d+\/members\/(\d+)$/u))) {
      const member = this.members.get(match[1]!);
      if (!member) throw new ApiError(404, ErrorCode.UnknownMember, 'Unknown Member');
      if (method === 'GET') return ok(member);
      if (method === 'PATCH') return ok(this.modifyMember(match[1]!, body ?? {}));
    }

    if (method === 'POST' && (match = path.match(/^\/channels\/(\d+)\/messages$/u))) {
      const channel = this.channels.get(match[1]!);
      if (!channel) throw new ApiError(404, ErrorCode.UnknownChannel, 'Unknown Channel');
      this.requireChat(channel);
      return ok(this.storeMessage(channel.id, body ?? {}));
    }

    if ((match = path.match(/^\/channels\/(\d+)\/messages\/(\d+)$/u))) {
      const message = this.messages.get(match[2]!);
      if (!this.channels.has(match[1]!)) throw new ApiError(404, ErrorCode.UnknownChannel, 'Unknown Channel');
      if (!message || message.channel_id !== match[1]) throw new ApiError(404, ErrorCode.UnknownMessage, 'Unknown Message');
      if (method === 'PATCH') return ok(this.reviseMessage(message, body ?? {}));
      if (method === 'DELETE') {
        this.messages.delete(message.id);
        return { status: 204 };
      }
    }

    if (method === 'POST' && (match = path.match(/^\/interactions\/\d+\/([^/]+)\/callback$/u))) {
      this.acknowledge(match[1]!, body ?? {});
      return { status: 204 };
    }
    if (method === 'PATCH' && (match = path.match(/^\/webhooks\/\d+\/([^/]+)\/messages\/@original$/u))) {
      return ok(this.editOriginal(match[1]!, body ?? {}));
    }
    if (method === 'POST' && (match = path.match(/^\/webhooks\/\d+\/([^/]+)$/u))) {
      const pending = this.interactions.get(match[1]!);
      if (!pending?.callback) throw new ApiError(404, 10015, 'Unknown Webhook');
      const followUp = this.storeMessage(pending.channelId, body ?? {});
      pending.followUps.push(followUp);
      return ok(followUp);
    }

    this.unexpected.push(`${method} ${path}`);
    throw new ApiError(404, 0, '404: Not Found');
  }

  // channels

  private createChannel(body: Json): Json {
    const bot = this.guildPermissions(this.botId);
    if ((bot & P.ManageChannels) === 0n) throw new ApiError(403, ErrorCode.MissingPermissions, 'Missing Permissions');

    const type = body.type ?? ChannelKind.Text;
    this.validateChannelFields(body, type);
    let parent: Json | undefined;
    if (body.parent_id) {
      parent = this.channels.get(body.parent_id);
      if (parent?.type !== ChannelKind.Category) invalid('parent_id: not a category');
      const siblings = [...this.channels.values()].filter((channel) => channel.parent_id === body.parent_id).length;
      if (siblings >= 50) invalid('parent_id: Maximum number of channels in category reached (50)');
    }

    let overwrites: Json[];
    if (body.permission_overwrites) {
      overwrites = normalizeOverwrites(body.permission_overwrites);
      // "Only permissions your bot has in the guild can be allowed/denied", and only
      // administrators may put Manage Roles into an overwrite.
      if (bot !== ALL_PERMISSIONS) {
        for (const overwrite of overwrites) {
          const touched = BigInt(overwrite.allow) | BigInt(overwrite.deny);
          if ((touched & ~bot) !== 0n || (touched & P.ManageRoles) !== 0n) {
            throw new ApiError(403, ErrorCode.MissingPermissions, 'Missing Permissions');
          }
        }
      }
    } else {
      overwrites = clone(parent?.permission_overwrites ?? []);
    }

    const id = this.nextId();
    const channel = this.channelPayload(id, type, body.name, body.parent_id ?? null, overwrites, {
      bitrate: body.bitrate,
      userLimit: body.user_limit,
    });
    if (body.rtc_region) channel.rtc_region = body.rtc_region;
    if (body.video_quality_mode === 2) channel.video_quality_mode = 2;
    this.channels.set(id, channel);
    this.dispatch('CHANNEL_CREATE', channel);
    return channel;
  }

  private modifyChannel(channel: Json, body: Json): Json {
    this.requireManageable(channel);
    this.validateChannelFields(body, channel.type);
    const bot = this.guildPermissions(this.botId);

    if (body.permission_overwrites !== undefined) {
      if (!this.can(this.botId, channel.id, P.ManageRoles)) {
        throw new ApiError(403, ErrorCode.MissingPermissions, 'Missing Permissions');
      }
      const next = normalizeOverwrites(body.permission_overwrites);
      if (bot !== ALL_PERMISSIONS) {
        // The bot may only change permissions it holds itself; bits it leaves as they were are fine.
        const before = new Map((channel.permission_overwrites as Json[]).map((overwrite) => [overwrite.id, overwrite]));
        const after = new Map(next.map((overwrite) => [overwrite.id, overwrite]));
        for (const id of new Set([...before.keys(), ...after.keys()])) {
          const changed =
            (BigInt(before.get(id)?.allow ?? 0) ^ BigInt(after.get(id)?.allow ?? 0)) |
            (BigInt(before.get(id)?.deny ?? 0) ^ BigInt(after.get(id)?.deny ?? 0));
          if ((changed & ~bot) !== 0n || (changed & P.ManageRoles) !== 0n) {
            throw new ApiError(403, ErrorCode.MissingPermissions, 'Missing Permissions');
          }
        }
      }
      channel.permission_overwrites = next;
    }

    if (body.name !== undefined && body.name !== channel.name) {
      const limit = this.options.renameLimit;
      if (limit) {
        const now = Date.now();
        const recent = (this.renames.get(channel.id) ?? []).filter((at) => now - at < limit.windowMs);
        if (recent.length >= limit.count) {
          throw new ApiError(429, 0, 'You are being rate limited.', { 'retry-after': String(limit.retryAfterSeconds) });
        }
        this.renames.set(channel.id, [...recent, now]);
      }
      channel.name = body.name;
    }
    if (body.user_limit !== undefined) channel.user_limit = body.user_limit;
    if (body.bitrate !== undefined) channel.bitrate = body.bitrate;
    if (body.rtc_region !== undefined) channel.rtc_region = body.rtc_region;
    if (body.video_quality_mode !== undefined) {
      if (body.video_quality_mode === 2) channel.video_quality_mode = 2;
      else delete channel.video_quality_mode;
    }

    this.dispatch('CHANNEL_UPDATE', channel);
    return channel;
  }

  private removeChannel(channel: Json): void {
    this.channels.delete(channel.id);
    for (const [messageId, message] of this.messages) {
      if (message.channel_id === channel.id) this.messages.delete(messageId);
    }
    this.dispatch('CHANNEL_DELETE', channel);
    for (const userId of this.membersIn(channel.id)) this.changeVoice(userId, { channel_id: null });
  }

  private validateChannelFields(body: Json, type: number): void {
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 100) {
        invalid('name: Must be between 1 and 100 in length.');
      }
    }
    if (type !== ChannelKind.Voice) return;
    if (body.user_limit !== undefined && (!Number.isInteger(body.user_limit) || body.user_limit < 0 || body.user_limit > 99)) {
      invalid('user_limit: int value should be between 0 and 99.');
    }
    if (body.bitrate !== undefined && (!Number.isInteger(body.bitrate) || body.bitrate < 8000 || body.bitrate > this.options.maxBitrate)) {
      invalid(`bitrate: int value should be between 8000 and ${this.options.maxBitrate}.`);
    }
    if (body.rtc_region != null && !VOICE_REGIONS.some((region) => region.id === body.rtc_region)) {
      invalid('rtc_region: Value must be one of the known regions.');
    }
    if (body.video_quality_mode != null && body.video_quality_mode !== 1 && body.video_quality_mode !== 2) {
      invalid('video_quality_mode: Value must be one of {1, 2}.');
    }
    if (body.permission_overwrites && body.permission_overwrites.length > 100) {
      invalid('permission_overwrites: Must be 100 or fewer in length.');
    }
  }

  /** Managing a voice channel takes being able to see and connect to it, plus Manage Channels. */
  private requireManageable(channel: Json): void {
    this.requireAccess(channel);
    if (!this.can(this.botId, channel.id, P.ManageChannels)) {
      throw new ApiError(403, ErrorCode.MissingPermissions, 'Missing Permissions');
    }
  }

  private requireAccess(channel: Json): void {
    const needed = channel.type === ChannelKind.Voice ? P.ViewChannel | P.Connect : P.ViewChannel;
    if (!this.can(this.botId, channel.id, needed)) throw new ApiError(403, ErrorCode.MissingAccess, 'Missing Access');
  }

  private requireChat(channel: Json): void {
    this.requireAccess(channel);
    if (!this.can(this.botId, channel.id, P.SendMessages)) {
      throw new ApiError(403, ErrorCode.MissingPermissions, 'Missing Permissions');
    }
  }

  // members

  private modifyMember(userId: string, body: Json): Json {
    const state = this.voiceOf(userId);
    const touchesVoice = 'channel_id' in body || 'mute' in body || 'deaf' in body;
    if (touchesVoice) {
      if (!state.channel_id) throw new ApiError(400, ErrorCode.NotConnectedToVoice, 'Target user is not connected to voice.');
      const here = state.channel_id;
      const need = (permission: bigint): void => {
        if (!this.can(this.botId, here, permission)) throw new ApiError(403, ErrorCode.MissingPermissions, 'Missing Permissions');
      };
      if ('mute' in body) need(P.MuteMembers);
      if ('deaf' in body) need(P.DeafenMembers);
      if ('channel_id' in body) {
        need(P.MoveMembers);
        if (body.channel_id !== null) {
          const destination = this.channels.get(body.channel_id);
          if (!destination) throw new ApiError(400, ErrorCode.UnknownChannel, 'Unknown Channel');
          // "The current user must have permissions to both connect to the channel and have the MOVE_MEMBERS permission."
          if (!this.canJoin(this.botId, destination.id)) throw new ApiError(403, ErrorCode.MissingPermissions, 'Missing Permissions');
        }
      }
      const change: Partial<{ channel_id: string | null; mute: boolean; deaf: boolean }> = {};
      if ('channel_id' in body) change.channel_id = body.channel_id;
      if ('mute' in body) change.mute = body.mute;
      if ('deaf' in body) change.deaf = body.deaf;
      this.changeVoice(userId, change);
    }
    return { ...this.requireMember(userId), mute: state.mute, deaf: state.deaf };
  }

  // messages

  private storeMessage(channelId: string, body: Json, extraFlags = 0): Json {
    validateMessage(body, true);
    const id = this.nextId();
    const message: Json = {
      id,
      channel_id: channelId,
      author: this.members.get(this.botId)!.user,
      content: body.content ?? '',
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: mentionedUsers(body).map((userId) => this.members.get(userId)?.user).filter(Boolean),
      mention_roles: [],
      attachments: [],
      embeds: body.embeds ?? [],
      pinned: false,
      type: 0,
      flags: (body.flags ?? 0) | extraFlags,
      components: body.components ?? [],
    };
    this.messages.set(id, message);
    return message;
  }

  private reviseMessage(message: Json, body: Json): Json {
    validateMessage({ flags: message.flags, ...body }, false);
    if (body.content !== undefined) message.content = body.content ?? '';
    if (body.components !== undefined) message.components = body.components;
    if (body.embeds !== undefined) message.embeds = body.embeds;
    if (body.flags !== undefined) message.flags |= body.flags & COMPONENTS_V2;
    // An edit never notifies anyone again, but the list of who the message mentions follows its new content.
    message.mentions = mentionedUsers({ ...message, allowed_mentions: body.allowed_mentions })
      .map((userId) => this.members.get(userId)?.user)
      .filter(Boolean);
    message.edited_timestamp = new Date().toISOString();
    return message;
  }

  // interaction responses

  private acknowledge(token: string, body: Json): void {
    const pending = this.interactions.get(token);
    if (!pending) throw new ApiError(404, 10062, 'Unknown interaction');
    if (pending.callback) throw new ApiError(400, ErrorCode.AlreadyAcknowledged, 'Interaction has already been acknowledged.');
    pending.callback = { type: body.type, data: body.data };

    switch (body.type) {
      case Callback.Reply:
        pending.message = this.storeMessage(pending.channelId, body.data ?? {});
        pending.finish();
        break;
      case Callback.Update:
        if (!pending.source) invalid('This interaction has no message to update');
        pending.message = this.reviseMessage(pending.source!, body.data ?? {});
        pending.finish();
        break;
      case Callback.Autocomplete:
        pending.choices = body.data?.choices ?? [];
        if (pending.choices!.length > 25) invalid('choices: Must be 25 or fewer in length.');
        pending.finish();
        break;
      case Callback.Modal:
        validateModal(body.data ?? {});
        pending.modal = body.data;
        pending.finish();
        break;
      case Callback.DeferredReply:
      case Callback.DeferredUpdate:
        break;
      default:
        invalid(`type: unsupported interaction callback type ${body.type}`);
    }
  }

  private editOriginal(token: string, body: Json): Json {
    const pending = this.interactions.get(token);
    if (!pending?.callback) throw new ApiError(404, 10015, 'Unknown Webhook');

    const updatesSource = pending.callback.type === Callback.DeferredUpdate || pending.callback.type === Callback.Update;
    if (updatesSource) {
      if (!pending.source) invalid('This interaction has no message to update');
      pending.message = this.reviseMessage(pending.source!, body);
    } else if (pending.message) {
      pending.message = this.reviseMessage(pending.message, body);
    } else {
      // The reply inherits "only you can see this" from the deferral.
      const ephemeral = ((pending.callback.data?.flags ?? 0) & EPHEMERAL) as number;
      pending.message = this.storeMessage(pending.channelId, body, ephemeral);
    }
    pending.finish();
    return pending.message;
  }

  // ── payloads ──────────────────────────────────────────────────────────

  private guildPayload(): Json {
    const connected = [...this.voice].filter(([, state]) => state.channel_id !== null).map(([userId]) => userId);
    return {
      id: this.guildId,
      name: 'Test Server',
      icon: null,
      splash: null,
      discovery_splash: null,
      owner_id: this.ownerId,
      afk_channel_id: null,
      afk_timeout: 300,
      verification_level: 0,
      default_message_notifications: 0,
      explicit_content_filter: 0,
      roles: [...this.roles.values()],
      emojis: [],
      stickers: [],
      features: [],
      mfa_level: 0,
      application_id: null,
      system_channel_id: null,
      system_channel_flags: 0,
      rules_channel_id: null,
      public_updates_channel_id: null,
      joined_at: new Date(0).toISOString(),
      large: false,
      unavailable: false,
      member_count: this.members.size,
      // Without the members intent Discord only sends the bot itself and whoever is in voice.
      members: [this.members.get(this.botId)!, ...connected.map((userId) => this.members.get(userId)!)],
      voice_states: connected.map((userId) => {
        const { guild_id: _guildId, ...state } = this.voicePayload(userId);
        return state;
      }),
      channels: [...this.channels.values()],
      threads: [],
      presences: [],
      stage_instances: [],
      guild_scheduled_events: [],
      soundboard_sounds: [],
      max_members: 500_000,
      vanity_url_code: null,
      description: null,
      banner: null,
      premium_tier: this.options.maxBitrate >= 384_000 ? 3 : this.options.maxBitrate >= 256_000 ? 2 : this.options.maxBitrate >= 128_000 ? 1 : 0,
      premium_subscription_count: 0,
      preferred_locale: 'en-US',
      nsfw_level: 0,
      premium_progress_bar_enabled: false,
    };
  }

  private voicePayload(userId: string): Json {
    const state = this.voiceOf(userId);
    return {
      guild_id: this.guildId,
      channel_id: state.channel_id,
      user_id: userId,
      member: { ...this.requireMember(userId), mute: state.mute, deaf: state.deaf },
      session_id: `session-${userId}`,
      deaf: state.deaf,
      mute: state.mute,
      self_deaf: false,
      self_mute: false,
      self_video: false,
      suppress: false,
      request_to_speak_timestamp: null,
    };
  }

  private channelPayload(
    id: string,
    type: number,
    name: string,
    parentId: string | null,
    overwrites: Json[],
    options: { bitrate?: number; userLimit?: number },
  ): Json {
    const channel: Json = {
      id,
      type,
      guild_id: this.guildId,
      name,
      position: this.channels.size,
      parent_id: parentId,
      permission_overwrites: overwrites,
      flags: 0,
    };
    if (type === ChannelKind.Voice) {
      Object.assign(channel, {
        bitrate: options.bitrate ?? 64_000,
        user_limit: options.userLimit ?? 0,
        rtc_region: null,
        nsfw: false,
        rate_limit_per_user: 0,
        last_message_id: null,
      });
    }
    return channel;
  }

  private rolePayload(id: string, name: string, permissions: bigint, position: number): Json {
    return {
      id,
      name,
      color: 0,
      colors: { primary_color: 0, secondary_color: null, tertiary_color: null },
      hoist: false,
      icon: null,
      unicode_emoji: null,
      position,
      permissions: String(permissions),
      managed: false,
      mentionable: false,
      flags: 0,
    };
  }

  private userPayload(id: string, username: string, bot = false): Json {
    return { id, username, discriminator: '0', global_name: null, avatar: null, bot, public_flags: 0 };
  }

  private memberPayload(user: Json, roles: string[]): Json {
    return {
      user,
      nick: null,
      avatar: null,
      roles,
      joined_at: new Date(0).toISOString(),
      premium_since: null,
      deaf: false,
      mute: false,
      flags: 0,
      pending: false,
      communication_disabled_until: null,
    };
  }

  private requireMember(userId: string): Json {
    const member = this.members.get(userId);
    if (!member) throw new Error(`No member ${userId} in the fake server`);
    return member;
  }

  private requireChannel(channelId: string): Json {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`No channel ${channelId} in the fake server`);
    return channel;
  }

  private nextId(): string {
    this.lastId += 1n;
    return String(this.lastId);
  }
}

// ── permission resolution ───────────────────────────────────────────────────

export interface PermissionQuestion {
  /** The member's server-wide permissions (@everyone plus all their roles). */
  base: bigint;
  userId: string;
  roleIds: readonly string[];
  /** Id of the @everyone role, which is the guild id. */
  everyoneId: string;
  overwrites: readonly { id: string; type: number; allow: string | bigint; deny: string | bigint }[];
}

/**
 * A member's permissions in a channel, following the order Discord documents:
 * the @everyone overwrite, then all role overwrites together (denies before
 * allows), then the member's own overwrite. Administrators are the caller's
 * business: they bypass overwrites entirely.
 */
export function resolvePermissions(question: PermissionQuestion): bigint {
  const { base, userId, roleIds, everyoneId, overwrites } = question;
  let permissions = base;

  const everyone = overwrites.find((overwrite) => overwrite.id === everyoneId);
  if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);

  let allow = 0n;
  let deny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== OverwriteKind.Role || overwrite.id === everyoneId) continue;
    if (!roleIds.includes(overwrite.id)) continue;
    allow |= BigInt(overwrite.allow);
    deny |= BigInt(overwrite.deny);
  }
  permissions = (permissions & ~deny) | allow;

  const own = overwrites.find((overwrite) => overwrite.type === OverwriteKind.Member && overwrite.id === userId);
  if (own) permissions = (permissions & ~BigInt(own.deny)) | BigInt(own.allow);
  return permissions;
}

// ── helpers for reading what the bot sent ───────────────────────────────────

/** Every component in a message, however deeply nested. */
export function allComponents(message: Json): Json[] {
  const found: Json[] = [];
  const visit = (component: Json): void => {
    found.push(component);
    for (const child of (component.components as Json[] | undefined) ?? []) visit(child);
    if (component.accessory) visit(component.accessory);
    if (component.component) visit(component.component);
  };
  for (const component of (message.components as Json[] | undefined) ?? []) visit(component);
  return found;
}

export function findComponent(message: Json, customId: string): Json | undefined {
  return allComponents(message).find((component) => component.custom_id === customId);
}

/** All the text a person would read in a message. */
export function textOf(message: Json): string {
  const parts = [message.content as string | undefined];
  for (const component of allComponents(message)) {
    if (component.type === Component.TextDisplay) parts.push(component.content);
  }
  return parts.filter(Boolean).join('\n');
}

/** The entries of a select menu, as `{ label, value, default }`. */
export function optionsOf(message: Json, customId: string): Json[] {
  const menu = findComponent(message, customId);
  if (!menu) throw new Error(`No menu "${customId}" on that message`);
  return menu.options ?? [];
}

// ── validation, following Discord's documented limits ───────────────────────

interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function ok(body: unknown, status = 200): Reply {
  return { status, body };
}

function invalid(detail: string): never {
  throw new ApiError(400, ErrorCode.InvalidFormBody, `Invalid Form Body (${detail})`);
}

export function validateMessage(body: Json, creating: boolean): void {
  const flags: number = body.flags ?? 0;
  const components: Json[] = body.components ?? [];
  const v2 = (flags & COMPONENTS_V2) !== 0;

  if (v2) {
    if (body.content) invalid('content: not allowed in a components-only message');
    if (body.embeds?.length) invalid('embeds: not allowed in a components-only message');
    const topLevel: number[] = [
      Component.ActionRow,
      Component.Section,
      Component.TextDisplay,
      Component.MediaGallery,
      Component.File,
      Component.Separator,
      Component.Container,
    ];
    for (const component of components) {
      if (!topLevel.includes(component.type)) invalid(`components: type ${component.type} cannot be at the top level`);
    }
    if (components.length === 0) invalid('components: a components-only message needs components');
  } else {
    if (typeof body.content === 'string' && body.content.length > 2000) invalid('content: Must be 2000 or fewer in length.');
    if (components.length > 5) invalid('components: Must be 5 or fewer in length.');
    for (const component of components) {
      if (component.type !== Component.ActionRow) invalid('components: only action rows are allowed at the top level');
    }
    if (creating && !body.content && !body.embeds?.length && components.length === 0) {
      invalid('Cannot send an empty message');
    }
  }

  const all = allComponents({ components });
  if (all.length > 40) invalid('components: a message holds at most 40 components');
  const text = all.filter((component) => component.type === Component.TextDisplay);
  if (text.reduce((total, component) => total + String(component.content ?? '').length, 0) > 4000) {
    invalid('components: text is limited to 4000 characters per message');
  }

  const ids = new Set<string>();
  for (const component of all) {
    validateComponent(component);
    if (component.custom_id === undefined) continue;
    if (ids.has(component.custom_id)) invalid(`components: custom_id "${component.custom_id}" is used twice`);
    ids.add(component.custom_id);
  }
}

function validateComponent(component: Json): void {
  const where = `component ${component.custom_id ?? `of type ${component.type}`}`;
  const maxLength = (value: unknown, max: number, field: string): void => {
    if (typeof value === 'string' && value.length > max) invalid(`${where}: ${field} must be ${max} or fewer in length`);
  };
  if (component.custom_id !== undefined) {
    if (typeof component.custom_id !== 'string' || component.custom_id.length < 1) invalid(`${where}: custom_id is required`);
    maxLength(component.custom_id, 100, 'custom_id');
  }

  switch (component.type) {
    case Component.ActionRow: {
      const children: Json[] = component.components ?? [];
      if (children.length < 1 || children.length > 5) invalid(`${where}: an action row holds 1 to 5 components`);
      const selects = children.filter((child) => child.type !== Component.Button);
      if (selects.length > 0 && children.length > 1) invalid(`${where}: a select menu must be alone in its row`);
      break;
    }
    case Component.Button:
      if (![1, 2, 3, 4].includes(component.style)) invalid(`${where}: unsupported button style`);
      if (!component.custom_id) invalid(`${where}: a button needs a custom_id`);
      if (!component.label && !component.emoji) invalid(`${where}: a button needs a label or an emoji`);
      maxLength(component.label, 80, 'label');
      break;
    case Component.StringSelect: {
      const options: Json[] = component.options ?? [];
      if (options.length < 1 || options.length > 25) invalid(`${where}: a select menu holds 1 to 25 options`);
      const values = new Set<string>();
      for (const option of options) {
        if (!option.label) invalid(`${where}: every option needs a label`);
        maxLength(option.label, 100, 'option label');
        maxLength(option.value, 100, 'option value');
        maxLength(option.description, 100, 'option description');
        if (values.has(option.value)) invalid(`${where}: option value "${option.value}" is used twice`);
        values.add(option.value);
      }
      validateSelectBounds(component, where, options.length);
      const preselected = options.filter((option) => option.default).length;
      if (preselected > (component.max_values ?? 1)) invalid(`${where}: more default options than max_values`);
      break;
    }
    case Component.UserSelect: {
      validateSelectBounds(component, where, 25);
      const defaults: Json[] = component.default_values ?? [];
      const min = component.min_values ?? 1;
      const max = component.max_values ?? 1;
      if (defaults.length > 0 && (defaults.length < min || defaults.length > max)) {
        invalid(`${where}: the number of default values must be between min_values and max_values`);
      }
      for (const value of defaults) {
        if (value.type !== 'user' || !/^\d+$/u.test(value.id)) invalid(`${where}: malformed default value`);
      }
      break;
    }
    case Component.TextDisplay:
      if (typeof component.content !== 'string' || component.content.length < 1) invalid(`${where}: content is required`);
      break;
    case Component.Container: {
      const allowed: number[] = [
        Component.ActionRow,
        Component.Section,
        Component.TextDisplay,
        Component.MediaGallery,
        Component.File,
        Component.Separator,
      ];
      for (const child of (component.components as Json[]) ?? []) {
        if (!allowed.includes(child.type)) invalid(`${where}: type ${child.type} cannot be inside a container`);
      }
      break;
    }
    case Component.Separator:
      break;
    default:
      invalid(`${where}: the fake does not know component type ${component.type}`);
  }
}

function validateSelectBounds(component: Json, where: string, available: number): void {
  const min = component.min_values ?? 1;
  const max = component.max_values ?? 1;
  if (!Number.isInteger(min) || min < 0 || min > 25) invalid(`${where}: min_values must be between 0 and 25`);
  if (!Number.isInteger(max) || max < 1 || max > 25) invalid(`${where}: max_values must be between 1 and 25`);
  if (min > max) invalid(`${where}: min_values is greater than max_values`);
  if (max > available) invalid(`${where}: max_values is greater than the number of options`);
  if (typeof component.placeholder === 'string' && component.placeholder.length > 150) {
    invalid(`${where}: placeholder must be 150 or fewer in length`);
  }
}

export function validateModal(modal: Json): void {
  if (typeof modal.custom_id !== 'string' || modal.custom_id.length < 1 || modal.custom_id.length > 100) {
    invalid('modal: custom_id must be between 1 and 100 in length');
  }
  if (typeof modal.title !== 'string' || modal.title.length < 1 || modal.title.length > 45) {
    invalid('modal: title must be between 1 and 45 in length');
  }
  const components: Json[] = modal.components ?? [];
  if (components.length < 1 || components.length > 5) invalid('modal: needs 1 to 5 components');
  for (const label of components) {
    if (label.type !== Component.Label) invalid('modal: components must be labels');
    if (typeof label.label !== 'string' || label.label.length < 1 || label.label.length > 45) {
      invalid('modal: a label must be between 1 and 45 in length');
    }
    if (typeof label.description === 'string' && label.description.length > 100) {
      invalid('modal: a label description must be 100 or fewer in length');
    }
    const input = label.component as Json | undefined;
    if (input?.type !== Component.TextInput) invalid('modal: the fake only knows text inputs');
    if (!input!.custom_id || input!.custom_id.length > 100) invalid('modal: a text input needs a custom_id');
    if (![1, 2].includes(input!.style)) invalid('modal: unsupported text input style');
    if (input!.label !== undefined) invalid('modal: a text input inside a label must not carry its own label');
    const max = input!.max_length ?? 4000;
    if (max < 1 || max > 4000) invalid('modal: max_length must be between 1 and 4000');
    if (typeof input!.value === 'string' && input!.value.length > max) invalid('modal: value is longer than max_length');
  }
}

function validateCommand(command: Json): void {
  const name = /^[-_\p{L}\p{N}]{1,32}$/u;
  const check = (node: Json, depth: number): void => {
    if (!name.test(node.name) || node.name !== node.name.toLowerCase()) invalid(`command: bad name "${node.name}"`);
    if (typeof node.description !== 'string' || node.description.length < 1 || node.description.length > 100) {
      invalid(`command: the description of "${node.name}" must be between 1 and 100 in length`);
    }
    const options: Json[] = node.options ?? [];
    if (options.length > 25) invalid(`command: "${node.name}" has more than 25 options`);
    let optionalSeen = false;
    for (const option of options) {
      if (option.type > 2) {
        if (option.required && optionalSeen) invalid(`command: required options of "${node.name}" must come first`);
        if (!option.required) optionalSeen = true;
      }
      if ((option.choices?.length ?? 0) > 25) invalid(`command: "${option.name}" has more than 25 choices`);
      for (const choice of (option.choices as Json[] | undefined) ?? []) {
        if (choice.name.length < 1 || choice.name.length > 100) invalid(`command: bad choice name "${choice.name}"`);
      }
      if (depth < 2) check(option, depth + 1);
    }
  };
  check(command, 0);
}

function assertSelectionSize(menu: Json, count: number): void {
  const min = menu.min_values ?? 1;
  const max = menu.max_values ?? 1;
  if (count < min || count > max) {
    throw new Error(`Menu "${menu.custom_id}" takes ${min} to ${max} choices, not ${count}`);
  }
}

function normalizeOverwrites(overwrites: Json[]): Json[] {
  return overwrites.map((overwrite) => ({
    id: String(overwrite.id),
    type: Number(overwrite.type),
    allow: String(BigInt(overwrite.allow ?? 0)),
    deny: String(BigInt(overwrite.deny ?? 0)),
  }));
}

function toOverwritePayload(overwrite: OverwriteInit): Json {
  return {
    id: overwrite.id,
    type: overwrite.type === 'role' ? OverwriteKind.Role : OverwriteKind.Member,
    allow: String(overwrite.allow ?? 0n),
    deny: String(overwrite.deny ?? 0n),
  };
}

/** Who a message actually pings: everyone it mentions and is allowed to. */
function mentionedUsers(body: Json): string[] {
  const allowed: string[] | undefined = body.allowed_mentions?.users;
  const parseUsers: boolean = body.allowed_mentions ? (body.allowed_mentions.parse ?? []).includes('users') : true;
  const mentioned = [...textOf(body).matchAll(/<@!?(\d+)>/gu)].map((match) => match[1]!);
  return [...new Set(mentioned)].filter((userId) => parseUsers || (allowed ?? []).includes(userId));
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === name) return String(value);
  }
  return undefined;
}

function describe(data: Json): string {
  return data.custom_id ?? `/${data.name} ${data.options?.[0]?.name ?? ''}`.trim();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
