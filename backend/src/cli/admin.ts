/**
 * Server-console administration (never exposed over the network):
 *   npm run admin -- create <usuario>            cria o proprietario (pede senha), mostra o segredo TOTP
 *   npm run admin -- device-add <id> [nome]      cria dispositivo e mostra a chave UMA vez
 *   npm run admin -- enroll [nome]               gera codigo de cadastro (15 min)
 *   npm run admin -- revoke <id>                 revoga dispositivo
 *   npm run admin -- ota-publish <arquivo.bin>   registra firmware (aprovar no painel)
 *   npm run admin -- backup <destino.db>         copia consistente do banco (VACUUM INTO), servidor pode estar rodando
 *   npm run admin -- check                       verifica requisitos do ambiente
 */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { loadConfig } from '../config/index.ts';
import { Db } from '../storage/db.ts';
import { SecretBox } from '../security/crypto.ts';
import { AdminAuth } from '../auth/admin.ts';
import { Devices } from '../devices/devices.ts';
import { Ota } from '../ota/ota.ts';
import { runProcess } from '../providers/cliRunner.ts';

process.umask(0o077); // files created by the CLI (backups, data) are owner-only
const cfg = loadConfig();
const db = Db.open(cfg.dataDir);
const box = SecretBox.load(cfg.dataDir, cfg.masterKey);
const [cmd, a1, a2] = process.argv.slice(2);

function askHidden(q: string): Promise<string> {
  const muted = new Writable({ write(_c, _e, cb) { cb(); } });
  process.stdout.write(q);
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  return new Promise((res) => rl.question('', (v) => { rl.close(); process.stdout.write('\n'); res(v); }));
}

switch (cmd) {
  case 'create': {
    if (!a1) throw new Error('uso: create <usuario>');
    const p1 = await askHidden('Senha (min. 12): ');
    const p2 = await askHidden('Repita: ');
    if (p1 !== p2) { console.error('senhas diferentes'); process.exit(1); }
    const { totpSecret } = new AdminAuth(db, box, { sessionMinutes: 30, requireTotp: cfg.adminRequireTotp }).createAdmin(a1, p1);
    console.log('Proprietario criado. Cadastre no app autenticador (TOTP, 6 digitos, 30 s):');
    console.log('  segredo: ' + totpSecret);
    console.log(`  otpauth://totp/TerminalMatematico:${a1}?secret=${totpSecret}&issuer=TerminalMatematico`);
    break;
  }
  case 'device-add': { const key = new Devices(db, box, cfg.clockSkewSec).create(String(a1), a2 ?? String(a1)); console.log('device_id : ' + a1 + '\ndevice_key: ' + key + '\n(Exibida uma unica vez.)'); break; }
  case 'enroll': console.log('codigo de cadastro (15 min): ' + new Devices(db, box, cfg.clockSkewSec).createEnrollment(a1 ?? 'dispositivo')); break;
  case 'revoke': new Devices(db, box, cfg.clockSkewSec).setEnabled(String(a1), false); console.log('revogado: ' + a1); break;
  case 'ota-publish': { const info = new Ota(db, cfg.dataDir).publish(String(a1), a2 ?? ''); console.log('publicado (aguardando aprovacao no painel):', info); break; }
  case 'backup': {
    if (!a1 || !/^[\w./-]+\.db$/.test(a1)) throw new Error('uso: backup <destino.db>');
    const { existsSync } = await import('node:fs');
    if (existsSync(a1)) throw new Error('destino ja existe');
    db.run('VACUUM INTO ?', a1);
    console.log('copia criada: ' + a1 + ' (contem dados cifrados; guarde junto com master.key separadamente)');
    break;
  }
  case 'check': {
    const [maj, min] = process.versions.node.split('.').map(Number);
    console.log(`Node ${process.version}: ${maj > 22 || (maj === 22 && min >= 13) ? 'OK' : 'requer >= 22.13'}`);
    for (const [name, bin] of [['Codex CLI', cfg.codexBin], ['Claude Code', cfg.claudeBin], ['cloudflared', 'cloudflared']]) {
      const r = await runProcess(bin, ['--version'], { cwd: cfg.dataDir, timeoutMs: 8000 });
      console.log(`${name}: ${r.code === 0 ? r.stdout.trim().split('\n')[0] : 'nao encontrado (opcional)'}`);
    }
    console.log(`dados em ${cfg.dataDir}; perfil ${cfg.profile}; tunel 127.0.0.1:${cfg.tunnelPort}; LAN ${cfg.lanEnabled ? cfg.lanPort : 'desligada'}`);
    break;
  }
  default: console.log('comandos: create | device-add | enroll | revoke | ota-publish | backup | check');
}
db.close();
