/**
 * Device provisioning: creates a random 256-bit HMAC key for a device and stores
 * it in the devices file. The key is printed ONCE so it can be written to the
 * device's encrypted NVS (see docs/PROVISIONING.md). Usage:
 *   npm run provision -- <device-id> [name]
 *   npm run provision -- --disable <device-id>
 */
import { randomBytes } from 'node:crypto';
import { FileDeviceStore } from '../deviceAuth.ts';
import { loadConfig } from '../config.ts';

const args = process.argv.slice(2);
const store = new FileDeviceStore(loadConfig().devicesFile);

if (args[0] === '--disable' && args[1]) {
  const rec = store.get(args[1]);
  if (!rec) { console.error('dispositivo inexistente'); process.exit(1); }
  store.put(args[1], { ...rec, enabled: false });
  console.log('desativado:', args[1]);
  process.exit(0);
}

const id = args[0];
if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
  console.error('uso: npm run provision -- <device-id> [nome]');
  process.exit(1);
}
if (store.get(id)) { console.error('dispositivo ja existe; desative e use outro id para trocar a chave'); process.exit(1); }
const key = randomBytes(32).toString('base64');
store.put(id, { keyB64: key, enabled: true, name: args[1], createdAt: new Date().toISOString() });
console.log('device_id :', id);
console.log('device_key:', key);
console.log('Grave a chave no NVS criptografado do dispositivo. Ela nao sera exibida novamente.');
