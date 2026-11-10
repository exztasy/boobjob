import { existsSync } from 'node:fs';
import { isLogLevel, type LogLevel } from './logger.js';

export interface Config {
  token: string;
  databasePath: string;
  logLevel: LogLevel;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Reads settings from the environment, loading a local `.env` file first if there is one. */
export function loadConfig(envFile = '.env'): Config {
  // Variables already present in the environment win over the file.
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const token = process.env.DISCORD_TOKEN?.trim();
  if (!token) {
    throw new ConfigError(
      'DISCORD_TOKEN is not set. Copy .env.example to .env and paste your bot token into it.',
    );
  }

  const logLevel = process.env.LOG_LEVEL?.trim().toLowerCase() || 'info';
  if (!isLogLevel(logLevel)) {
    throw new ConfigError(`LOG_LEVEL must be one of debug, info, warn, error or silent (got "${logLevel}").`);
  }

  return {
    token,
    databasePath: process.env.DATABASE_PATH?.trim() || './data/bot.sqlite',
    logLevel,
  };
}
