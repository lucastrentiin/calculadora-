#!/usr/bin/env node
/*
 * Builds the CSV consumed by ESP-IDF's nvs_partition_gen.py to write the
 * device identity into the "mtdata" partition (namespace "mt").
 *   node tools/provision_device.js <device-id> <device-key-base64> [--lan URL] [--remote URL] [--cf-id ID --cf-secret SECRET] > provision.csv
 * Then (see docs/PROVISIONING.md):
 *   python $IDF_PATH/components/nvs_flash/nvs_partition_generator/nvs_partition_gen.py \
 *       encrypt provision.csv mtdata.bin 0x100000 --inputkey keys/nvs_key.bin   (production)
 *   esptool.py --chip esp32s3 write_flash 0xC20000 mtdata.bin
 * The CSV contains secrets: create it in a temporary directory and delete it afterwards.
 * The device key and the optional Cloudflare Access service token are device
 * credentials for the owner's server; no AI provider key or account password
 * is ever written to the device.
 */
'use strict';
const args = process.argv.slice(2);
const [id, key] = args;
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const fail = (m) => { console.error(m); process.exit(1); };
if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || !key || Buffer.from(key, 'base64').length !== 32) {
  fail('uso: node tools/provision_device.js <device-id> <chave-base64-de-32-bytes> [--lan https://...] [--remote https://...] [--cf-id ID --cf-secret SEGREDO]');
}
const url = (v, name) => {
  if (v === undefined) return undefined;
  let u; try { u = new URL(v); } catch { fail(`${name}: URL invalida`); }
  if (u.protocol !== 'https:') fail(`${name}: use https://`);
  if (v.length > 127) fail(`${name}: longa demais`);
  return v.replace(/\/$/, '');
};
const lan = url(opt('--lan'), '--lan'), remote = url(opt('--remote'), '--remote');
const cfId = opt('--cf-id'), cfSecret = opt('--cf-secret');
if ((cfId && !cfSecret) || (!cfId && cfSecret)) fail('--cf-id e --cf-secret devem ser informados juntos');
if (cfId && (cfId.length > 79 || cfSecret.length > 95 || !/^[\x21-\x7e]+$/.test(cfId + cfSecret))) fail('token do Cloudflare Access invalido');
const b64 = (s) => Buffer.from(s).toString('base64');
const rows = ['key,type,encoding,value', 'mt,namespace,,', `dev_id,data,base64,${b64(id)}`, `dev_key,data,base64,${key}`];
if (lan) rows.push(`lan_url,data,base64,${b64(lan)}`);
if (remote) rows.push(`remote_url,data,base64,${b64(remote)}`);
if (cfId) rows.push(`cf_id,data,base64,${b64(cfId)}`, `cf_secret,data,base64,${b64(cfSecret)}`);
process.stdout.write(rows.join('\n') + '\n');
