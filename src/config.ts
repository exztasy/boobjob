import { existsSync } from 'node:fs';
import { isLogLevel, type LogLevel } from './logger.js';
import type { LavalinkAddress } from './music/lavalink/node.js';

export interface MusicConfig {
  /** The Lavalink server that fetches and streams the audio. */
  lavalink: LavalinkAddress;
  /** Tokens of additional bot accounts, each of which can play in one more voice channel per server. */
  botTokens: string[];
}

export interface Config {
  token: string;
  databasePath: string;
  logLevel: LogLevel;
  /** `null` when no Lavalink server is configured: the bot then runs without the music feature. */
  music: MusicConfig | null;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Reads settings from the environment, loading a local `.env` file first if there is one. */
export function loadConfig(envFile = '.env'): Config {
  // Variables already present in the environment win over the file.
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return readConfig(process.env);
}

/** Works out the settings from a set of environment variables. */
export function readConfig(env: Record<string, string | undefined>): Config {
  const token = env.DISCORD_TOKEN?.trim();
  if (!token) {
    throw new ConfigError(
      'DISCORD_TOKEN is not set. Copy .env.example to .env and paste your bot token into it.',
    );
  }

  const logLevel = env.LOG_LEVEL?.trim().toLowerCase() || 'info';
  if (!isLogLevel(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of debug, info, warn, error or silent (got "${logLevel}").`);
  }

  return {
    token,
    databasePath: env.DATABASE_PATH?.trim() || './data/bot.sqlite',
    logLevel,
    music: readMusicConfig(env, token),
  };
}

/** Music is switched on by telling the bot the password of a Lavalink server. */
function readMusicConfig(env: Record<string, string | undefined>, mainToken: string): MusicConfig | null {
  const botTokens = [...new Set((env.MUSIC_BOT_TOKENS ?? '').split(/[\s,]+/u).filter(Boolean))];
  const password = env.LAVALINK_PASSWORD?.trim();

  if (!password) {
    if (botTokens.length > 0) {
      throw new ConfigError(
        'MUSIC_BOT_TOKENS is set but LAVALINK_PASSWORD is not. Music needs a Lavalink server; see "Music" in the README.',
      );
    }
    return null;
  }
  if (botTokens.includes(mainToken)) {
    throw new ConfigError(
      'MUSIC_BOT_TOKENS contains the token from DISCORD_TOKEN. It is for additional bots; the main bot plays music anyway.',
    );
  }

  const port = Number(env.LAVALINK_PORT?.trim() || '2333');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(`LAVALINK_PORT must be a port number from 1 to 65535 (got "${env.LAVALINK_PORT}").`);
  }
  const secure = env.LAVALINK_SECURE?.trim().toLowerCase() || 'false';
  if (secure !== 'true' && secure !== 'false') {
    throw new ConfigError(`LAVALINK_SECURE must be true or false (got "${env.LAVALINK_SECURE}").`);
  }

  return {
    lavalink: {
      host: env.LAVALINK_HOST?.trim() || 'localhost',
      port,
      password,
      secure: secure === 'true',
    },
    botTokens,
  };
}
