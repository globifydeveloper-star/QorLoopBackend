import { Database } from './database.js';
import { loadConfig } from '../../shared/src/config.js';
import { AuthService } from '../../../apps/api/src/auth/auth.service.js';

const config = loadConfig();
if (config.NODE_ENV === 'production') throw new Error('Development seed is disabled in production');
const db = new Database(config.DATABASE_URL);
try {
  const result = await new AuthService(db, config).provision({
    name: 'Doha Fresh Markets', slug: 'dohafresh', hostname: 'dohafresh.localhost', ownerEmail: 'owner@example.test',
  });
  console.log(JSON.stringify({ ...result, ownerEmail: 'owner@example.test', emailDelivery: 'queued; start the worker and open Mailpit' }, null, 2));
} finally { await db.close(); }

