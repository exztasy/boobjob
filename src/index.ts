import { Bot } from './bot.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const log = createLogger(config.logLevel);
  const bot = new Bot({ token: config.token, databasePath: config.databasePath, log });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info(`Received ${signal}, shutting down`);
    bot.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        log.error('Shutdown did not complete cleanly', error);
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A handler that slips up should cost one action, not the whole bot.
  process.on('unhandledRejection', (reason) => log.error('Unhandled promise rejection', reason));

  try {
    await bot.start();
  } catch (error) {
    if (isInvalidToken(error)) {
      log.error('Discord rejected the token. Check that DISCORD_TOKEN is the bot token of your application.');
    } else {
      log.error('Could not connect to Discord', error);
    }
    await bot.stop().catch(() => undefined);
    process.exitCode = 1;
  }
}

function isInvalidToken(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'TokenInvalid';
}

await main();
