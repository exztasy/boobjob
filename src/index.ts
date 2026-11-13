import { GatewayCloseCodes } from 'discord.js';
import { Bot } from './bot.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { DatabaseError } from './storage/database.js';
import { isInvalidToken } from './util/discord.js';

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

  let stopping = false;
  function shutdown(exitCode: number): void {
    if (stopping) return;
    stopping = true;
    bot.stop().then(
      () => process.exit(exitCode),
      (error: unknown) => {
        log.error('Shutdown did not complete cleanly', error);
        process.exit(1);
      },
    );
  }

  let bot: Bot;
  try {
    bot = new Bot({
      token: config.token,
      databasePath: config.databasePath,
      log,
      music: config.music,
      // Discord will not let this connection be re-established, so all that is left is to
      // stop. Exiting with an error lets whatever supervises the process notice and react,
      // instead of the bot sitting there connected to nothing.
      onFatalDisconnect: (closeCode) => {
        log.error(describeFatalClose(closeCode));
        shutdown(1);
      },
    });
  } catch (error) {
    if (!(error instanceof DatabaseError)) throw error;
    log.error(error.message);
    process.exitCode = 1;
    return;
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      log.info(`Received ${signal}, shutting down`);
      shutdown(0);
    });
  }

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

function describeFatalClose(closeCode: number): string {
  if (closeCode === GatewayCloseCodes.AuthenticationFailed) {
    return 'Discord closed the connection because the bot token is no longer valid. If the token was reset, put the new one in DISCORD_TOKEN.';
  }
  const name = GatewayCloseCodes[closeCode] ?? 'unknown reason';
  return `Discord closed the connection and will not accept a reconnect (close code ${closeCode}, ${name}).`;
}

await main();
