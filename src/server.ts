import { buildApp } from './app.js';
import { env } from './config/env.js';
import { initBoss } from './jobs/boss.js';

async function start() {
  try {
    const app = await buildApp();

    await app.listen({
      port: env.PORT,
      host: env.HOST
    });

    app.log.info(`Qorloop API listening on http://${env.HOST}:${env.PORT}`);
    app.log.info(`API Documentation available at http://${env.HOST}:${env.PORT}/docs`);
    app.log.info(`Health check endpoint at http://${env.HOST}:${env.PORT}/health`);

    initBoss().catch((err) => {
      app.log.warn(`[pg-boss] worker deferred: ${err.message}`);
    });
  } catch (err) {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  }
}

start();
