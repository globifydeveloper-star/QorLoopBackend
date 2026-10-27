import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema/index.js';

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/qorloop_dev';
const TENANT_ID = process.env.TENANT_ID || '00000000-0000-0000-0000-000000000001';

async function seed() {
  console.log('[db:seed] Seeding database at:', connectionString);
  const client = postgres(connectionString);
  const db = drizzle(client, { schema });

  try {
    // 1. Global Marketplaces
    console.log('Seeding global marketplaces...');
    await db.insert(schema.marketplaces).values([
      { id: 'talabat', name: 'Talabat' },
      { id: 'snoonu', name: 'Snoonu' },
      { id: 'rafeeq', name: 'Rafeeq' },
      { id: 'keeta', name: 'Keeta' }
    ]).onConflictDoNothing();

    // 2. Tenant
    console.log('Seeding default tenant: Doha Fresh Markets...');
    await db.insert(schema.tenants).values({
      id: TENANT_ID,
      name: 'Doha Fresh Markets',
      subdomain: 'dohafresh',
      country: 'QA',
      currency: 'QAR',
      timezone: 'Asia/Qatar',
      erpName: 'RetailOne',
      status: 'active',
      onboardingStep: 'welcome'
    }).onConflictDoNothing();

    // 3. Tenant Settings
    await db.insert(schema.tenantSettings).values({
      tenantId: TENANT_ID,
      priceTolerance: '0.000',
      stockThreshold: 0,
      staleHours: 12,
      mfaRequiredForAll: false,
      analystCanExport: true
    }).onConflictDoNothing();

    // 4. Pricing Settings
    await db.insert(schema.pricingSettings).values({
      tenantId: TENANT_ID,
      defaultRuleMode: 'percent',
      defaultRuleValue: '10.000',
      rounding: '0.25',
      perMarketplaceEnabled: false,
      compareReferenceDefault: 'marketplace'
    }).onConflictDoNothing();

    // 5. Seed Users for all 4 roles
    const seedUsers = [
      { id: 'usr-owner-01', name: 'Owner User', email: 'owner@dohafresh.qa', role: 'owner' as const },
      { id: 'usr-admin-01', name: 'Admin User', email: 'admin@dohafresh.qa', role: 'admin' as const },
      { id: 'usr-cat-01', name: 'Catalogue Manager', email: 'catalogue@dohafresh.qa', role: 'catalogue_manager' as const },
      { id: 'usr-analyst-01', name: 'Analyst User', email: 'analyst@dohafresh.qa', role: 'analyst' as const }
    ];

    console.log('\n========================================');
    console.log(' SEEDED CREDENTIALS (for local testing)');
    console.log('========================================');

    for (const u of seedUsers) {
      await db.insert(schema.users).values({
        id: u.id,
        name: u.name,
        email: u.email,
        emailVerified: true
      }).onConflictDoNothing();

      await db.insert(schema.memberships).values({
        userId: u.id,
        tenantId: TENANT_ID,
        role: u.role,
        status: 'active'
      }).onConflictDoNothing();

      console.log(`[${u.role.toUpperCase()}] ${u.email} / password: Password123!`);
    }
    console.log('========================================\n');

    console.log('[db:seed] Seed completed successfully.');
  } finally {
    await client.end();
  }
}

seed().catch((err) => {
  console.error('[db:seed] Error seeding:', err.message);
  process.exit(1);
});
