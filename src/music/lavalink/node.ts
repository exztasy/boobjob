import WebSocket from 'ws';
import {
  LavalinkError,
  type LoadResult,
  type Player,
  type PlayerEvent,
  type PlayerState,
  type PlayerUpdate,
  type ServerInfo,
} from './protocol.js';

/** How to reach a Lavalink server. */
export interface LavalinkAddress {
  host: string;
  port: number;
  password: string;
  secure: boolean;
}

export interface NodeOptions {
  address: LavalinkAddress;
  /** The bot account this connection plays music as. */
  userId: string;
  clientName: string;
  /** How long to wait before trying again after the connection failed or dropped. */
  retryMs: number;
  /** How long a single request to Lavalink may take. */
  requestTimeoutMs: number;
  /** How often to check that the connection is still alive. */
  pingIntervalMs: number;
}

export interface NodeHandlers {
  /** The connection is up; players can be created. */
  ready(): void;
  /**
   * The connection is gone, or could not be made. `wasReady` tells the two
   * apart. Lavalink drops every player of a connection that closes, so after
   * this nothing of what was playing is left.
   */
  down(reason: string, wasReady: boolean): void;
  event(event: PlayerEvent): void;
  playerState(guildId: string, state: PlayerState): void;
}

/**
 * One bot's connection to a Lavalink server: the websocket that Lavalink
 * reports on, and the REST calls that tell it what to do. The connection is
 * kept up for as long as the node is running; a server that is down or
 * restarting is simply retried until it is back.
 */
export class LavalinkNode {
  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly options: NodeOptions,
    private readonly handlers: NodeHandlers,
  ) {}

  /** Whether Lavalink is connected and ready to take commands. */
  get ready(): boolean {
    return this.sessionId !== null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.stopPinging();
    const socket = this.socket;
    this.socket = null;
    this.sessionId = null;
    if (socket) {
      socket.removeAllListeners();
      // Closing a socket that is still connecting makes it report an error; there is nobody left to care.
      socket.on('error', () => undefined);
      socket.terminate();
    }
  }

  // ── the websocket ───────────────────────────────────────────────────────

  private connect(): void {
    const { address, userId, clientName, requestTimeoutMs } = this.options;
    const socket = new WebSocket(`${address.secure ? 'wss' : 'ws'}://${address.host}:${address.port}/v4/websocket`, {
      headers: { Authorization: address.password, 'User-Id': userId, 'Client-Name': clientName },
      handshakeTimeout: requestTimeoutMs,
    });
    this.socket = socket;

    // An error is always followed by the socket closing, which is where it is dealt with.
    let failure: string | undefined;
    socket.on('error', (error) => {
      failure = describeConnectionError(error);
    });
    socket.on('close', (code) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopPinging();
      const wasReady = this.sessionId !== null;
      this.sessionId = null;
      this.handlers.down(failure ?? `the connection was closed (code ${code})`, wasReady);
      if (this.running) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (this.running) this.connect();
        }, this.options.retryMs);
        this.retryTimer.unref();
      }
    });
    socket.on('open', () => this.startPinging(socket));
    socket.on('message', (data) => {
      if (this.socket === socket) this.receive(String(data));
    });
  }

  private receive(raw: string): void {
    let message: { op?: string; [key: string]: unknown };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      return;
    }
    switch (message.op) {
      case 'ready':
        this.sessionId = String(message.sessionId);
        this.handlers.ready();
        break;
      case 'event':
        this.handlers.event(message as unknown as PlayerEvent);
        break;
      case 'playerUpdate':
        this.handlers.playerState(String(message.guildId), message.state as PlayerState);
        break;
      default:
      // `stats` and anything newer than this client: nothing to do.
    }
  }

  /**
   * The bot never sends anything over the websocket, so a connection that has
   * silently died would go unnoticed and every player with it. A ping that
   * stays unanswered until the next one is due gives it away.
   */
  private startPinging(socket: WebSocket): void {
    let answered = true;
    socket.on('pong', () => {
      answered = true;
    });
    this.pingTimer = setInterval(() => {
      if (!answered) {
        socket.terminate();
        return;
      }
      answered = false;
      socket.ping();
    }, this.options.pingIntervalMs);
    this.pingTimer.unref();
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  // ── REST ────────────────────────────────────────────────────────────────

  /** Looks up a link or a search such as `ytsearch:some song`. */
  loadTracks(identifier: string): Promise<LoadResult> {
    return this.request('GET', `/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`);
  }

  /** Changes a player, creating it first if this guild has none yet. */
  updatePlayer(guildId: string, update: PlayerUpdate): Promise<Player> {
    return this.request('PATCH', `${this.playerPath(guildId)}?noReplace=false`, update);
  }

  getPlayer(guildId: string): Promise<Player> {
    return this.request('GET', this.playerPath(guildId));
  }

  async destroyPlayer(guildId: string): Promise<void> {
    await this.request('DELETE', this.playerPath(guildId));
  }

  info(): Promise<ServerInfo> {
    return this.request('GET', '/v4/info');
  }

  private playerPath(guildId: string): string {
    if (!this.sessionId) throw new LavalinkError(0, 'not connected to the music server');
    return `/v4/sessions/${this.sessionId}/players/${guildId}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { address, requestTimeoutMs } = this.options;
    let response: Response;
    try {
      response = await fetch(`${address.secure ? 'https' : 'http'}://${address.host}:${address.port}${path}`, {
        method,
        headers: {
          Authorization: address.password,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      throw new LavalinkError(0, describeRequestError(error, requestTimeoutMs));
    }

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { message?: unknown } | null;
      const message = typeof detail?.message === 'string' && detail.message ? detail.message : response.statusText;
      throw new LavalinkError(response.status, message || `HTTP ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new LavalinkError(response.status, 'the music server sent an answer that is not JSON');
    }
  }
}

function describeConnectionError(error: Error): string {
  // What `ws` reports when the server answers the handshake with a plain HTTP status.
  const status = /Unexpected server response: (\d+)/u.exec(error.message)?.[1];
  if (status === '401' || status === '403') return 'the password was rejected';
  if (status) return `the server answered with HTTP ${status}`;
  return describeNetworkError(error);
}

function describeRequestError(error: unknown, timeoutMs: number): string {
  if (error instanceof Error && error.name === 'TimeoutError') return `no answer within ${timeoutMs} ms`;
  // `fetch` hides the reason for a failed connection in the error's cause.
  if (error instanceof Error && error.cause instanceof Error) return describeNetworkError(error.cause);
  return error instanceof Error ? error.message : String(error);
}

function describeNetworkError(error: Error): string {
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  if (code === 'ECONNREFUSED') return 'the connection was refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'the host name could not be resolved';
  return error.message || code || 'the connection failed';
}
