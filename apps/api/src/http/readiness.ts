import { ServiceUnavailableException } from '@nestjs/common';

export type Components = { database: 'ok' | 'unavailable'; redis: 'ok' | 'degraded'; storage: 'ok' | 'degraded' };
export class ReadinessUnavailable extends ServiceUnavailableException {
  constructor(readonly components: Components) { super('Service unavailable'); }
}
async function available(check: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.resolve().then(check), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Readiness timeout')), 1500); })]);
    return true;
  } catch { return false; }
  finally { clearTimeout(timer); }
}
/** Only safe component states leave this function. Redis/storage degradation does not fail API readiness. */
export async function checkReadiness(database: () => Promise<unknown>, redis: () => Promise<unknown>, storage: () => Promise<unknown>) {
  const [db, cache, objects] = await Promise.all([available(database), available(redis), available(storage)]);
  const components: Components = { database: db ? 'ok' : 'unavailable', redis: cache ? 'ok' : 'degraded', storage: objects ? 'ok' : 'degraded' };
  if (!db) throw new ReadinessUnavailable(components);
  return { status: cache && objects ? 'ok' as const : 'degraded' as const, components };
}
