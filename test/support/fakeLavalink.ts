/**
 * A stand-in for a Lavalink server, for driving the bot's music feature in
 * tests. It is a real HTTP and websocket server speaking Lavalink's v4
 * protocol, modelled on Lavalink's own request handlers: the same
 * authentication, the same checks on player updates (a voice state without
 * a channel id is refused, as since Lavalink 4.2), the same events, and the
 * same shape of error responses. Instead of streaming audio it keeps track of
 * what each player would be doing, and lets a test decide when a track ends,
 * fails or gets stuck.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { LoadResult, Track, TrackInfo } from '../../src/music/lavalink/protocol.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = Record<string, any>;

export const LAVALINK_PASSWORD = 'test-password';

const SEARCH_PREFIXES: Record<string, string> = {
  ytsearch: 'youtube',
  ytmsearch: 'youtube',
  scsearch: 'soundcloud',
  spsearch: 'spotify',
};

export interface FakeVoice {
  token: string;
  endpoint: string;
  sessionId: string;
  channelId: string;
}

export interface FakePlayer {
  guildId: string;
  track: Track | null;
  paused: boolean;
  volume: number;
  position: number;
  voice: FakeVoice | null;
  /** Whether the audio connection to Discord is up. */
  connected: boolean;
}

interface Session {
  id: string;
  /** The bot this connection plays for. */
  userId: string;
  clientName: string | undefined;
  socket: WebSocket;
  players: Map<string, FakePlayer>;
}

export interface RecordedCall {
  method: string;
  path: string;
  body: Json | undefined;
  status: number;
}

export interface TrackSpec {
  title: string;
  author?: string;
  /** Milliseconds. */
  length?: number;
  source?: 'youtube' | 'soundcloud' | 'spotify' | 'bandcamp';
  uri?: string;
  isStream?: boolean;
}

export class FakeLavalink {
  readonly calls: RecordedCall[] = [];
  /** Every identifier that was looked up, in order. */
  readonly loads: string[] = [];
  /** Source managers the server says it has. */
  sourceManagers = ['youtube', 'soundcloud', 'spotify', 'bandcamp', 'twitch', 'vimeo'];
  password = LAVALINK_PASSWORD;

  private readonly sessions = new Map<string, Session>();
  private readonly tracks = new Map<string, Track>();
  private readonly byUri = new Map<string, LoadResult>();
  private readonly forced = new Map<string, LoadResult>();
  private readonly delays: { path: RegExp; ms: number }[] = [];
  private readonly failures: { method: string; path: RegExp; status: number; message: string }[] = [];
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly sockets = new Set<Socket>();
  private port = 0;
  private nextTrack = 1;

  // ── running ───────────────────────────────────────────────────────────

  get address(): { host: string; port: number; password: string; secure: boolean } {
    return { host: '127.0.0.1', port: this.port, password: this.password, secure: false };
  }

  get running(): boolean {
    return this.server !== null;
  }

  /** Starts the server, on the same port as before if it ran already. */
  async start(): Promise<void> {
    const wss = new WebSocketServer({ noServer: true });
    const server = createServer((request, response) => void this.handle(request, response));
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
    server.on('upgrade', (request, socket, head) => this.upgrade(wss, request, socket as Socket, head));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => resolve());
    });
    this.port = (server.address() as AddressInfo).port;
    this.server = server;
    this.wss = wss;
  }

  /** Stops the server the hard way, as when the process dies: every session and player is gone. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    for (const client of this.wss?.clients ?? []) client.terminate();
    this.wss?.close();
    this.wss = null;
    this.sessions.clear();
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // ── the catalogue ─────────────────────────────────────────────────────

  /** A track that searches can find and that can be played; also loadable by its link. */
  addTrack(spec: TrackSpec): Track {
    const number = this.nextTrack++;
    const source = spec.source ?? 'youtube';
    const identifier = `track-${number}`;
    const info: TrackInfo = {
      identifier,
      isSeekable: !spec.isStream,
      author: spec.author ?? 'Some Artist',
      length: spec.isStream ? Number.MAX_SAFE_INTEGER : (spec.length ?? 180_000),
      isStream: spec.isStream ?? false,
      position: 0,
      title: spec.title,
      uri: spec.uri ?? defaultUri(source, identifier),
      artworkUrl: null,
      isrc: null,
      sourceName: source,
    };
    const track: Track = { encoded: Buffer.from(`fake-track:${number}`).toString('base64'), info, pluginInfo: {}, userData: {} };
    this.tracks.set(track.encoded, track);
    if (info.uri) this.byUri.set(info.uri, { loadType: 'track', data: track });
    return track;
  }

  /** A playlist (or album) of new tracks, loadable by its link. */
  addPlaylist(name: string, specs: TrackSpec[], options: { uri: string; selectedTrack?: number }): Track[] {
    const tracks = specs.map((spec) => this.addTrack(spec));
    this.byUri.set(options.uri, {
      loadType: 'playlist',
      data: { info: { name, selectedTrack: options.selectedTrack ?? -1 }, tracks },
    });
    return tracks;
  }

  /** Answers a lookup of exactly this identifier with this result from now on. */
  respondTo(identifier: string, result: LoadResult | Json): void {
    this.forced.set(identifier, result as LoadResult);
  }

  // ── failure injection ─────────────────────────────────────────────────

  /** Makes the next matching request wait this long before it is answered. */
  delayNext(path: RegExp, ms: number): void {
    this.delays.push({ path, ms });
  }

  /** Makes the next matching request fail with this status. */
  failNext(method: string, path: RegExp, status: number, message: string): void {
    this.failures.push({ method, path, status, message });
  }

  /** Closes the websocket of a bot, as when the network between them broke. Lavalink then drops its players. */
  dropConnection(userId: string): void {
    for (const session of this.sessions.values()) {
      if (session.userId === userId) session.socket.terminate();
    }
  }

  // ── what the players do ───────────────────────────────────────────────

  /** The player of a bot in a server, if it has one. */
  playerOf(userId: string, guildId: string): FakePlayer | undefined {
    return this.sessionOf(userId)?.players.get(guildId);
  }

  /** Whether a bot is connected to this server with a session. */
  isConnected(userId: string): boolean {
    return this.sessionOf(userId) !== undefined;
  }

  /** The track a bot's player is playing in a server reaches its end. */
  finishTrack(userId: string, guildId: string): void {
    const { session, player, track } = this.playing(userId, guildId);
    player.track = null;
    player.position = 0;
    this.emit(session, { type: 'TrackEndEvent', guildId, track, reason: 'finished' });
  }

  /** The track a bot's player is playing in a server cannot be played after all. */
  failTrack(userId: string, guildId: string, exception: { message: string; severity: 'common' | 'suspicious' | 'fault' }): void {
    const { session, player, track } = this.playing(userId, guildId);
    player.track = null;
    player.position = 0;
    this.emit(session, {
      type: 'TrackExceptionEvent',
      guildId,
      track,
      exception: { ...exception, cause: `java.lang.Exception: ${exception.message}`, causeStackTrace: '...' },
    });
    this.emit(session, { type: 'TrackEndEvent', guildId, track, reason: 'loadFailed' });
  }

  /** The track stops delivering audio, which Lavalink reports without ending it. */
  stickTrack(userId: string, guildId: string): void {
    const { session, track } = this.playing(userId, guildId);
    this.emit(session, { type: 'TrackStuckEvent', guildId, track, thresholdMs: 10_000 });
  }

  /** Discord closes the audio connection of a bot's player. */
  closeVoice(userId: string, guildId: string, code: number, reason = ''): void {
    const session = this.sessionOf(userId);
    const player = session?.players.get(guildId);
    if (!session || !player) throw new Error(`Bot ${userId} has no player in guild ${guildId}`);
    player.connected = false;
    this.emit(session, { type: 'WebSocketClosedEvent', guildId, code, reason, byRemote: true });
  }

  /**
   * Sends an event as it is, such as one about a track that is no longer
   * playing: events cross the bot's requests on the wire, so one can arrive
   * after the bot has already moved on.
   */
  sendEvent(userId: string, event: Json): void {
    const session = this.sessionOf(userId);
    if (!session) throw new Error(`Bot ${userId} is not connected`);
    this.emit(session, event);
  }

  /** The audio connection of a bot's player comes back by itself. */
  restoreVoice(userId: string, guildId: string): void {
    const player = this.sessionOf(userId)?.players.get(guildId);
    if (!player) throw new Error(`Bot ${userId} has no player in guild ${guildId}`);
    player.connected = true;
  }

  /** Reports where a track is, as Lavalink does every few seconds. */
  reportPosition(userId: string, guildId: string, position: number): void {
    const session = this.sessionOf(userId);
    const player = session?.players.get(guildId);
    if (!session || !player) throw new Error(`Bot ${userId} has no player in guild ${guildId}`);
    player.position = position;
    this.sendOp(session, { op: 'playerUpdate', guildId, state: this.stateOf(player) });
  }

  // ── websocket ─────────────────────────────────────────────────────────

  private upgrade(wss: WebSocketServer, request: IncomingMessage, socket: Socket, head: Buffer): void {
    const reject = (status: number, text: string): void => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    };
    if (new URL(request.url ?? '/', 'http://localhost').pathname !== '/v4/websocket') return reject(404, 'Not Found');
    if (request.headers.authorization !== this.password) return reject(401, 'Unauthorized');
    const userId = String(request.headers['user-id'] ?? '');
    if (!/^\d+$/u.test(userId) || BigInt(userId) === 0n) return reject(400, 'Bad Request');

    wss.handleUpgrade(request, socket, head, (ws) => {
      const session: Session = {
        id: randomBytes(8).toString('hex'),
        userId,
        clientName: request.headers['client-name'] as string | undefined,
        socket: ws,
        players: new Map(),
      };
      this.sessions.set(session.id, session);
      ws.on('close', () => {
        // Not resumable: Lavalink shuts the session and its players down.
        if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
      });
      this.sendOp(session, { op: 'ready', resumed: false, sessionId: session.id });
    });
  }

  private sendOp(session: Session, message: Json): void {
    if (session.socket.readyState === session.socket.OPEN) session.socket.send(JSON.stringify(message));
  }

  private emit(session: Session, event: Json): void {
    this.sendOp(session, { op: 'event', ...event });
  }

  // ── REST ──────────────────────────────────────────────────────────────

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const method = request.method ?? 'GET';
    const raw = await readBody(request);
    let body: Json | undefined;
    try {
      body = raw ? (JSON.parse(raw) as Json) : undefined;
    } catch {
      return this.reply(response, method, url.pathname, undefined, 400, error(400, 'Bad Request', 'Malformed JSON', url.pathname));
    }

    const delay = this.delays.findIndex((candidate) => candidate.path.test(url.pathname));
    if (delay >= 0) {
      const [slow] = this.delays.splice(delay, 1);
      await new Promise((resolve) => setTimeout(resolve, slow!.ms));
    }

    const authorization = request.headers.authorization;
    if (authorization === undefined) return this.reply(response, method, url.pathname, body, 401, null);
    if (authorization !== this.password) return this.reply(response, method, url.pathname, body, 403, null);

    const failure = this.failures.findIndex((candidate) => candidate.method === method && candidate.path.test(url.pathname));
    if (failure >= 0) {
      const [forced] = this.failures.splice(failure, 1);
      return this.reply(response, method, url.pathname, body, forced!.status, error(forced!.status, 'Error', forced!.message, url.pathname));
    }

    let status = 200;
    let answer: unknown;
    try {
      [status, answer] = this.route(method, url, body);
    } catch (problem) {
      if (!(problem instanceof HttpProblem)) throw problem;
      status = problem.status;
      answer = error(problem.status, problem.reason, problem.message, url.pathname);
    }
    this.reply(response, method, url.pathname, body, status, answer);
  }

  private reply(response: ServerResponse, method: string, path: string, body: Json | undefined, status: number, answer: unknown): void {
    this.calls.push({ method, path, body, status });
    if (answer === null || answer === undefined || status === 204) {
      response.writeHead(status).end();
      return;
    }
    if (typeof answer === 'string') {
      response.writeHead(status, { 'content-type': 'text/plain' }).end(answer);
      return;
    }
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
  }

  private route(method: string, url: URL, body: Json | undefined): [number, unknown] {
    const path = url.pathname;
    let match: RegExpMatchArray | null;

    if (method === 'GET' && path === '/version') return [200, '4.2.1'];
    if (method === 'GET' && path === '/v4/info') {
      return [
        200,
        {
          version: { semver: '4.2.1', major: 4, minor: 2, patch: 1, preRelease: null, build: null },
          buildTime: 0,
          git: { branch: 'fake', commit: 'fake', commitTime: 0 },
          jvm: '21',
          lavaplayer: 'fake',
          sourceManagers: this.sourceManagers,
          filters: [],
          plugins: [],
        },
      ];
    }
    if (method === 'GET' && path === '/v4/loadtracks') {
      const identifier = url.searchParams.get('identifier');
      if (identifier === null) throw new HttpProblem(400, 'Bad Request', "Required parameter 'identifier' is not present.");
      this.loads.push(identifier);
      return [200, this.load(identifier)];
    }

    if ((match = path.match(/^\/v4\/sessions\/([^/]+)\/players\/(\d+)$/u))) {
      const session = this.sessions.get(match[1]!);
      if (!session) throw new HttpProblem(404, 'Not Found', 'Session not found');
      const guildId = match[2]!;
      if (method === 'GET') {
        const player = session.players.get(guildId);
        if (!player) throw new HttpProblem(404, 'Not Found', 'Player not found');
        return [200, this.playerJson(player)];
      }
      if (method === 'PATCH') {
        const noReplace = url.searchParams.get('noReplace') === 'true';
        return [200, this.playerJson(this.updatePlayer(session, guildId, body ?? {}, noReplace))];
      }
      if (method === 'DELETE') {
        const player = session.players.get(guildId);
        session.players.delete(guildId);
        // Lavalink stops the track of a player it destroys, and says so.
        if (player?.track) this.emit(session, { type: 'TrackEndEvent', guildId, track: player.track, reason: 'stopped' });
        return [204, null];
      }
    }

    throw new HttpProblem(404, 'Not Found', 'Not Found');
  }

  private load(identifier: string): LoadResult {
    const forced = this.forced.get(identifier);
    if (forced) return forced;
    const known = this.byUri.get(identifier);
    if (known) return known;

    const search = /^([a-z]+):(.*)$/su.exec(identifier);
    const source = search ? SEARCH_PREFIXES[search[1]!] : undefined;
    if (search && source) {
      const words = search[2]!.toLowerCase();
      const found = [...this.tracks.values()].filter(
        (track) => track.info.sourceName === source && track.info.title.toLowerCase().includes(words),
      );
      return found.length > 0 ? { loadType: 'search', data: found } : { loadType: 'empty', data: {} };
    }
    return { loadType: 'empty', data: {} };
  }

  /** What Lavalink's PATCH handler does, minus the audio. */
  private updatePlayer(session: Session, guildId: string, update: Json, noReplace: boolean): FakePlayer {
    const track = update.track as Json | undefined;
    if (track && 'encoded' in track && 'identifier' in track) {
      throw new HttpProblem(400, 'Bad Request', 'Cannot specify both encodedTrack and identifier');
    }
    const voice = update.voice as Json | undefined;
    if (voice !== undefined) {
      const blank = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '';
      if (blank(voice.token) || blank(voice.endpoint) || blank(voice.sessionId) || blank(voice.channelId)) {
        throw new HttpProblem(400, 'Bad Request', 'token, endpoint, sessionId and channelId must be provided in voice state');
      }
    }
    if (update.volume !== undefined && !Number.isInteger(update.volume)) throw new HttpProblem(400, 'Bad Request', 'Bad Request');
    let next: Track | null | undefined;
    if (track && 'encoded' in track) {
      if (track.encoded === null) next = null;
      else {
        const known = this.tracks.get(String(track.encoded));
        if (!known) throw new HttpProblem(500, 'Internal Server Error', 'Failed to decode track');
        next = { ...known, userData: (track.userData as Json | undefined) ?? {} };
      }
    }

    let player = session.players.get(guildId);
    if (!player) {
      player = { guildId, track: null, paused: false, volume: 100, position: 0, voice: null, connected: false };
      session.players.set(guildId, player);
    }
    if (voice !== undefined) {
      player.voice = { token: voice.token, endpoint: voice.endpoint, sessionId: voice.sessionId, channelId: voice.channelId };
      player.connected = true;
    }
    // Like Lavalink, which clamps rather than refuses.
    if (update.volume !== undefined) player.volume = Math.min(Math.max(update.volume, 0), 1000);
    if (next === undefined) {
      if (typeof update.paused === 'boolean') player.paused = update.paused;
      if (typeof update.position === 'number' && player.track) player.position = update.position;
      return player;
    }

    if (noReplace && player.track) return player;
    player.paused = typeof update.paused === 'boolean' ? update.paused : false;
    const previous = player.track;
    player.track = next;
    player.position = 0;
    if (previous) {
      this.emit(session, { type: 'TrackEndEvent', guildId, track: previous, reason: next ? 'replaced' : 'stopped' });
    }
    if (next) {
      const started = next;
      // Lavaplayer starts the track on its own thread; the event comes after the answer.
      setImmediate(() => {
        if (player.track === started) this.emit(session, { type: 'TrackStartEvent', guildId, track: started });
      });
    }
    return player;
  }

  private playerJson(player: FakePlayer): Json {
    return {
      guildId: player.guildId,
      track: player.track,
      volume: player.volume,
      paused: player.paused,
      state: this.stateOf(player),
      voice: player.voice ?? { token: '', endpoint: '', sessionId: '', channelId: null },
      filters: {},
    };
  }

  private stateOf(player: FakePlayer): Json {
    return { time: Date.now(), position: player.position, connected: player.connected, ping: player.connected ? 20 : -1 };
  }

  private sessionOf(userId: string): Session | undefined {
    return [...this.sessions.values()].find((session) => session.userId === userId);
  }

  private playing(userId: string, guildId: string): { session: Session; player: FakePlayer; track: Track } {
    const session = this.sessionOf(userId);
    const player = session?.players.get(guildId);
    if (!session || !player?.track) throw new Error(`Bot ${userId} is not playing anything in guild ${guildId}`);
    return { session, player, track: player.track };
  }
}

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

function error(status: number, reason: string, message: string, path: string): Json {
  return { timestamp: Date.now(), status, error: reason, message, path };
}

function defaultUri(source: string, identifier: string): string {
  switch (source) {
    case 'soundcloud':
      return `https://soundcloud.com/some-artist/${identifier}`;
    case 'spotify':
      return `https://open.spotify.com/track/${identifier}`;
    case 'bandcamp':
      return `https://some-artist.bandcamp.com/track/${identifier}`;
    default:
      return `https://www.youtube.com/watch?v=${identifier}`;
  }
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
