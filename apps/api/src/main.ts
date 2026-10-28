import * as Sentry from '@sentry/node';
import { loadConfig } from '../../../packages/shared/src/config.js';
import { buildApp } from './app.js';

const config = loadConfig();
if (config.SENTRY_DSN) Sentry.init({ dsn: config.SENTRY_DSN, beforeSend(event) {
  delete event.request;
  delete event.user;
  delete event.breadcrumbs;
  return event;
} });
const { app, server } = await buildApp(config);
app.enableShutdownHooks();
await app.listen(config.PORT, config.HOST);
server.log.info({ port: config.PORT }, 'Qorloop API listening');

