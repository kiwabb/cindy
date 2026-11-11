/**
 * Shared-datasets (multi-computer personal todos) over a REAL device-link transport.
 *
 *   pnpm exec tsx scripts/shared-datasets-relay-smoke.ts
 *
 * Starts the real self-hosted relay (packages/device-link-relay) on loopback, admits devices through
 * its real join flow, and runs each simulated desktop as its own Node process
 * (scripts/shared-datasets-relay-device.ts: real DeviceLinkClient + real desktop inbound dispatcher
 * + real engine/storage + real personal-todo store; see that file for what is mirrored). The parent
 * only issues the user-level commands (enable / add / edit / set home / resolve), kills or blocks
 * processes, and asserts on each device's stored todos and sync status. Flushes and mirror
 * updates must come from presence and the real `changed` push, not from calling syncNow
 * (any explicit syncNow is labelled in the output).
 *
 * Deterministic: fixture account only, loopback relay, fresh temp dirs, polling with deadlines.
 * Only processes started here are killed (exact PID); only the unique temp dir is removed.
 * Takes roughly 3 minutes (engine debounce/backoff constants run in real time).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  acceptRelayDeviceCert,
  buildRelayJoinLink,
  createRelayJoinIdentity,
  createRelayPairSecret,
  createRelaySigningKey,
  issueRelayDeviceCert,
  parseRelayJoinLink,
  submitRelayPairRequest,
  verifyRelayPairProof,
  waitForRelayApproval,
  type RelayFetch,
} from '../packages/device-link/src/index';
import { nodeRelayAuthCrypto as crypto } from '../packages/device-link/src/nodeRelayCrypto';
import { createDeviceCredential, initializeRelay, startRelayServer } from '../packages/device-link-relay/src/index';

const root = fileURLToPath(new URL('../', import.meta.url));
const requireDesktop = createRequire(path.join(root, 'apps/desktop/package.json'));
const { build } = requireDesktop('esbuild');

// ------------------------------------------------------------------ results

const results: Array<{ scenario: string; ok: boolean; evidence: string }> = [];
function check(scenario: string, ok: boolean, evidence: unknown) {
  const text = typeof evidence === 'string' ? evidence : JSON.stringify(evidence);
  results.push({ scenario, ok, evidence: text });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${scenario}  ${text}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor<T>(label: string, probe: () => Promise<T | undefined | false>, timeoutMs = 30_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > until) throw new Error(`timeout waiting for ${label}${last ? ` (${String(last).slice(0, 200)})` : ''}`);
    await sleep(150);
  }
}

// ------------------------------------------------------------------ bundle

async function buildDeviceBundle(outFile: string) {
  const stub = (names: string[]) => `
    const mk=(n)=>new Proxy(function(){}, {get:(t,k)=>k==='__esModule'?false:k==='then'?undefined:k==='default'?mk(n):mk(n+'.'+String(k)),apply:()=>mk(n+'()'),construct:()=>mk(n+'new'),has:()=>true});
    const app={getVersion:()=>'0.0.0-smoke',getPath:()=>process.env.SMOKE_USER_DATA,getAppPath:()=>process.env.SMOKE_USER_DATA,isPackaged:false,on(){},whenReady:()=>new Promise(()=>{}),getName:()=>'smoke',commandLine:{getSwitchValue:()=>''}};
    const E={__esModule:true,app,BrowserWindow:{getAllWindows:()=>[]}};
    for(const n of ${JSON.stringify(names)}) if(!(n in E)) E[n]=mk('electron.'+n);
    module.exports=E;`;
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        for (const m of fs.readFileSync(full, 'utf8').matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]electron['"]/g)) {
          for (const n of m[1].split(',')) if (n.trim() && !/^\s*type\s/.test(n)) names.add(n.trim().split(/\s+as\s+/)[0]);
        }
      }
    }
  };
  walk(path.join(root, 'apps/desktop/src'));
  await build({
    entryPoints: [path.join(root, 'scripts/shared-datasets-relay-device.ts')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'error',
    define: { 'import.meta.env': '__env', 'import.meta.url': '__importMetaUrl' },
    banner: { js: 'var __env={MODE:"test",DEV:false,PROD:true};var __importMetaUrl=require("url").pathToFileURL(__filename).href;' },
    external: ['better-sqlite3', 'node-pty', 'bufferutil', 'utf-8-validate', '*.node'],
    loader: { '.sh': 'text', '.html': 'text', '.md': 'text', '.txt': 'text', '.svg': 'text', '.css': 'text', '.png': 'dataurl', '.webp': 'dataurl', '.jpg': 'dataurl', '.ico': 'dataurl', '.mp3': 'dataurl', '.wav': 'dataurl', '.ttf': 'dataurl', '.woff2': 'dataurl', '.wasm': 'binary', '.node': 'empty' },
    plugins: [
      {
        name: 'vite-suffix-imports',
        setup(b: any) {
          b.onResolve({ filter: /\?(raw|inline|url)$/ }, (a: any) => {
            const p = a.path.replace(/\?.*$/, '');
            let f = path.resolve(a.resolveDir, p);
            if (!p.startsWith('.') && !path.isAbsolute(p)) {
              try { f = requireDesktop.resolve(p, { paths: [root, a.resolveDir] }); } catch { f = path.join(root, 'node_modules', p); }
            }
            return { path: f, namespace: 'q', pluginData: a.path };
          });
          b.onLoad({ filter: /.*/, namespace: 'q' }, (a: any) =>
            /\?(inline|url)$/.test(a.pluginData)
              ? { contents: 'module.exports=""', loader: 'js' }
              : { contents: `module.exports=${JSON.stringify(fs.existsSync(a.path) ? fs.readFileSync(a.path, 'utf8') : '')}`, loader: 'js' });
        },
      },
      {
        name: 'electron-stubs',
        setup(b: any) {
          b.onResolve({ filter: /^original-fs$/ }, () => ({ path: 'node:fs', external: true }));
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }));
          // The tag catalog the home publishes as `extras` (the real one lives in the local database).
          b.onResolve({ filter: /localDb[\\/]ipc[\\/]taskTags(\.js)?$/ }, () => ({ path: 'taskTags', namespace: 'stub' }));
          b.onLoad({ filter: /^electron$/, namespace: 'stub' }, () => ({ contents: stub([...names]), loader: 'js' }));
          b.onLoad({ filter: /^taskTags$/, namespace: 'stub' }, () => ({
            contents: "module.exports={executeTaskTags:async()=>({tags:[{id:'tag-1',name:'Smoke tag',color:'#888888'}]}),TASK_TAG_CHANNEL:'maker:task-tags'};",
            loader: 'js',
          }));
        },
      },
    ],
  });
}

// ------------------------------------------------------------------ relay world

interface Credential { deviceId: string; credential: string }

async function startRelay(deviceIds: string[], baseTemp: string) {
  const dataDir = await mkdtemp(path.join(baseTemp, 'relay-'));
  const owner = createDeviceCredential();
  const ownerKey = createRelaySigningKey(crypto);
  const relayId = randomUUID();
  const account = 'smoke-account';
  const [ownerDevice, ...others] = deviceIds;
  await initializeRelay({
    dataDir, name: 'Smoke relay', ownerUserId: account, ownerDeviceId: ownerDevice, ownerDeviceName: ownerDevice,
    ownerCredentialHash: owner.credentialHash, relayId, ownerPublicKey: ownerKey.publicKey,
    ownerCert: issueRelayDeviceCert(crypto, ownerKey.seed, { relayId, deviceId: ownerDevice, publicKey: ownerKey.publicKey, role: 'owner', issuedAt: Date.now() }),
  });
  const relay = await startRelayServer({ dataDir, port: 0 });
  const base = relay.localUrl;
  const call = async (method: string, pathname: string, init: { credential?: string; body?: unknown } = {}) => {
    const headers: Record<string, string> = {};
    if (init.credential) headers.authorization = `CindyRelay ${init.credential}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${pathname}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
    const json = (await res.json()) as Record<string, any>;
    if (!res.ok) throw new Error(`${method} ${pathname}: ${res.status}`);
    return json;
  };
  const credentials: Credential[] = [{ deviceId: ownerDevice, credential: owner.credential }];
  for (const deviceId of others) {
    const { code } = await call('POST', '/api/device-link/relay/admin/join-codes', { credential: owner.credential });
    const pairSecret = createRelayPairSecret(crypto);
    const link = parseRelayJoinLink(buildRelayJoinLink({ baseUrl: base, code, ownerPublicKey: ownerKey.publicKey, pairSecret, app: 'cindy' }))!;
    const relayFetch: RelayFetch = (url, init) => fetch(url, init);
    const identity = createRelayJoinIdentity(crypto, link, relayId, deviceId);
    const request = await submitRelayPairRequest(relayFetch, link, {
      deviceId, deviceName: deviceId, platform: 'darwin', appVersion: '0.0.0-smoke', accountUserId: account,
      publicKey: identity.publicKey, proof: identity.proof,
    });
    const approval = waitForRelayApproval(relayFetch, link, request, { deadlineMs: 30_000 });
    const { requests } = await call('GET', '/api/device-link/relay/admin/pair-requests', { credential: owner.credential });
    const pending = (requests as Array<Record<string, string>>).find((r) => r.requestId === request.requestId)!;
    if (!verifyRelayPairProof(crypto, pairSecret, { relayId, deviceId, publicKey: pending.publicKey, proof: pending.proof })) throw new Error('pairing proof mismatch');
    await call('POST', `/api/device-link/relay/admin/pair-requests/${request.requestId}/approve`, {
      credential: owner.credential,
      body: { cert: issueRelayDeviceCert(crypto, ownerKey.seed, { relayId, deviceId, publicKey: pending.publicKey, role: 'member', issuedAt: Date.now() }) },
    });
    const admitted = await approval;
    acceptRelayDeviceCert(crypto, link, { relayId, deviceId, publicKey: identity.publicKey, cert: admitted.cert });
    credentials.push({ deviceId, credential: admitted.credential });
  }
  return { relay, dataDir, wsUrl: `${base.replace(/^http/, 'ws')}/api/device-link/ws`, credentials };
}

// ------------------------------------------------------------------ devices

const pids = new Set<number>();
class Device {
  child!: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private ready!: () => void;
  alive = false;
  constructor(readonly deviceId: string, private readonly opts: { bundle: string; wsUrl: string; credential: string; userData: string; old?: boolean; platform?: string }) {}
  async start() {
    await mkdir(this.opts.userData, { recursive: true });
    // Real remote-control consent: this computer accepts same-account controllers.
    await writeFile(path.join(this.opts.userData, 'device-link-settings.json'), JSON.stringify({ remoteControlEnabled: true }));
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_PATH: [path.join(root, 'node_modules'), path.join(root, 'apps/desktop/node_modules')].join(path.delimiter),
      SMOKE_DEVICE_ID: this.deviceId, SMOKE_NAME: this.deviceId, SMOKE_USER_DATA: this.opts.userData,
      SMOKE_RELAY_WS: this.opts.wsUrl, SMOKE_CREDENTIAL: this.opts.credential, SMOKE_OLD_PEER: this.opts.old ? '1' : '0', SMOKE_PLATFORM: this.opts.platform ?? 'darwin',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    this.child = spawn(process.execPath, [this.opts.bundle], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    pids.add(this.child.pid!);
    this.alive = true;
    const ready = new Promise<void>((resolve) => { this.ready = resolve; });
    let stderr = '';
    this.child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg: any;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.ready) return this.ready();
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      msg.ok ? waiter.resolve(msg.result) : waiter.reject(new Error(`${this.deviceId}: ${msg.error}`));
    });
    this.child.on('exit', (code) => {
      this.alive = false;
      for (const waiter of this.pending.values()) waiter.reject(new Error(`${this.deviceId} exited (${code}) ${stderr.slice(-1500)}`));
      this.pending.clear();
    });
    await Promise.race([ready, sleep(60_000).then(() => { throw new Error(`${this.deviceId} did not start: ${stderr}`); })]);
    await waitFor(`${this.deviceId} online`, async () => (await this.rpc('ping')).status === 'online');
  }
  rpc<T = any>(cmd: string, args: unknown = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, cmd, args })}\n`);
    });
  }
  /** Hard kill of exactly this process (a crash or power-off, no graceful shutdown). */
  async kill() {
    const pid = this.child.pid!;
    await new Promise<void>((resolve) => { this.child.once('exit', () => resolve()); this.child.kill('SIGKILL'); });
    pids.delete(pid);
  }
  titles = async () => ((await this.rpc('list')) as Array<{ title: string }>).map((t) => t.title).sort();
  byTitle = async (title: string) => ((await this.rpc('list')) as Array<{ id: string; revision: number; title: string }>).find((t) => t.title === title);
}

async function peersSeen(d: Device, ids: string[]) {
  await waitFor(`${d.deviceId} sees peers`, async () => {
    const ping = await d.rpc('ping');
    return ids.every((id) => ping.peers.some((p: any) => p.id === id && p.online));
  });
}

// ------------------------------------------------------------------ scenarios

async function mainWorld(bundle: string, temp: string) {
  const world = await startRelay(['dev-A', 'dev-B', 'dev-C-old', 'dev-M-phone'], temp);
  const mk = (credential: Credential, old = false, platform?: string) =>
    new Device(credential.deviceId, { bundle, wsUrl: world.wsUrl, credential: credential.credential, userData: path.join(temp, `ud-${credential.deviceId}`), old, platform });
  const [A, B, C, M] = [mk(world.credentials[0]), mk(world.credentials[1]), mk(world.credentials[2], true), mk(world.credentials[3], false, 'ios')];
  try {
    await Promise.all([A.start(), B.start(), C.start(), M.start()]);
    await peersSeen(A, ['dev-B', 'dev-C-old', 'dev-M-phone']);
    await peersSeen(B, ['dev-A', 'dev-C-old', 'dev-M-phone']);

    // ---------------------------------------------------------------- 1
    await A.rpc('add', { title: 'a1' });
    await B.rpc('add', { title: 'b1' });
    await B.rpc('add', { title: 'b2' });
    const aEnable = await A.rpc('enable');
    check('1a enable on A -> home', aEnable.role === 'home', aEnable);
    const bEnable = await B.rpc('enable');
    await waitFor('B pending drained', async () => {
      const s = await B.rpc('status');
      return s.role === 'replica' && s.pending === 0 && (await A.titles()).length === 3;
    });
    const bStatus = await B.rpc('status');
    check('1b enable on B -> replica; B pre-existing todos imported to A once',
      bEnable.role === 'replica' && bStatus.homeName === 'dev-A' && JSON.stringify(await A.titles()) === '["a1","b1","b2"]' && JSON.stringify(await B.titles()) === '["a1","b1","b2"]',
      { bRole: bStatus.role, home: bStatus.homeName, A: await A.titles(), B: await B.titles(), aRaw: await A.rpc('rawCount') });
    await B.rpc('disable');
    await B.rpc('enable');
    await waitFor('B resynced after re-enable', async () => (await B.rpc('status')).pending === 0 && (await B.rpc('status')).role === 'replica');
    await sleep(1500);
    check('1c re-enable on B does not duplicate', JSON.stringify(await A.titles()) === '["a1","b1","b2"]' && (await A.rpc('rawCount')) === 3, { A: await A.titles(), aRaw: await A.rpc('rawCount'), B: await B.titles() });

    // ---------------------------------------------------------------- 6 (A home, B replica, C old)
    const probeC = await B.rpc('probe', { dst: 'dev-C-old', request: { action: 'caps' } });
    const cServed = (await C.rpc('counters')).served;
    check('6 old peer: CHANNEL_NOT_ALLOWED, never chosen as home, no snapshot/submit/handover served',
      probeC.ok === false && probeC.error.code === 'CHANNEL_NOT_ALLOWED' && Object.keys(cServed).length === 0 && bStatus.homeName === 'dev-A',
      { probe: probeC.error, cServed, bHome: bStatus.homeName });

    // ---------------------------------------------------------------- 2
    const b1 = (await B.byTitle('b1'))!;
    const bEdit = await B.rpc('edit', { id: b1.id, title: 'b1-edited-on-B', expectedRevision: b1.revision });
    await waitFor('edit on B reaches A', async () => (await A.titles()).includes('b1-edited-on-B'));
    check('2a edit on B appears on A', true, { sync: bEdit.sync, A: await A.titles() });
    const pushesBefore = (await B.rpc('counters')).pushesReceived;
    const a1 = (await A.byTitle('a1'))!;
    await A.rpc('edit', { id: a1.id, title: 'a1-edited-on-A', expectedRevision: a1.revision });
    await waitFor('A edit reaches B mirror', async () => (await B.titles()).includes('a1-edited-on-A'), 20_000);
    const pushesAfter = (await B.rpc('counters')).pushesReceived;
    check('2b edit on A updates B mirror via changed push', pushesAfter > pushesBefore, { pushesBefore, pushesAfter, B: await B.titles() });

    // Checklist (steps) edit on the replica reaches the home, and the home's steps come back to the replica mirror.
    const a1b = (await B.byTitle('a1-edited-on-A'))!;
    await B.rpc('steps', { id: a1b.id, subtasks: [{ title: 'step-one' }, { title: 'step-two', done: true }] });
    const stepKey = (list: Array<{ title: string; done: boolean }>) => JSON.stringify(list.map((s) => [s.title, s.done]));
    await waitFor('steps edit on B reaches A', async () => stepKey((await A.rpc('steps', { id: a1b.id })) as any) === '[["step-one",false],["step-two",true]]');
    await waitFor('steps come back to B mirror', async () => (await B.rpc('status')).pending === 0 && stepKey((await B.rpc('steps', { id: a1b.id })) as any) === '[["step-one",false],["step-two",true]]');
    check('2c steps edit on B reaches A and the B mirror', true, { A: await A.rpc('steps', { id: a1b.id }) });

    // ---------------------------------------------------------------- 3
    const before = await A.byTitle('b1-edited-on-B');
    const rawBefore = await A.rpc('rawCount');
    const submitsBefore = (await B.rpc('counters')).sent.submit ?? 0;
    await A.kill();
    await waitFor('B sees A offline', async () => !(await B.rpc('status')).homeOnline);
    const bb1 = (await B.byTitle('b1-edited-on-B'))!;
    for (const title of ['b1-off-1', 'b1-off-2', 'b1-off-3']) {
      const current = (await B.byTitle(title === 'b1-off-1' ? 'b1-edited-on-B' : `b1-off-${Number(title.slice(-1)) - 1}`))!;
      await B.rpc('edit', { id: current.id, title });
    }
    await B.rpc('add', { title: 'b-offline-new' });
    const offlineStatus = await B.rpc('status');
    check('3a B edits while A is down -> pending, home offline', offlineStatus.pending === 4 && offlineStatus.homeOnline === false, offlineStatus);
    await A.start();
    await waitFor('B flushes after A returns (push/presence driven)', async () => {
      const s = await B.rpc('status');
      return s.pending === 0 && s.homeOnline && !s.lastError && (await A.titles()).includes('b1-off-3');
    }, 60_000);
    const after = await A.byTitle('b1-off-3');
    const aTitles = await A.titles();
    const submitsAfter = (await B.rpc('counters')).sent.submit ?? 0;
    const finalStatus = await B.rpc('status');
    check('3b A restarted: queue flushed exactly once, back to synced',
      !!before && after!.id === before.id && after!.revision === before.revision + 3 && aTitles.filter((t) => t === 'b-offline-new').length === 1 && (await A.rpc('rawCount')) === rawBefore + 1 && finalStatus.pending === 0 && !finalStatus.lastError,
      { revisionBefore: before?.revision, revisionAfter: after?.revision, rawBefore, rawAfter: await A.rpc('rawCount'), A: aTitles, submitsSentByB: submitsAfter - submitsBefore, status: finalStatus, bb1: bb1.revision });

    // ---------------------------------------------------------------- 4
    await B.rpc('add', { title: 'y-theirs' });
    await waitFor('y-theirs on A', async () => (await A.titles()).includes('y-theirs'));
    // The mirror swaps the creation's placeholder id for the home's id on the snapshot after the flush.
    await waitFor('y-theirs on B carries the home id', async () => (await B.rpc('status')).pending === 0 && (await B.byTitle('y-theirs'))?.id === (await A.byTitle('y-theirs'))?.id);
    const x = (await B.byTitle('b1-off-3'))!;
    const y = (await B.byTitle('y-theirs'))!;
    const z = (await B.byTitle('b2'))!;
    await B.rpc('block');
    await waitFor('A sees B offline', async () => !(await A.rpc('ping')).peers.find((p: any) => p.id === 'dev-B')?.online);
    const ax = (await A.byTitle('b1-off-3'))!;
    const ay = (await A.byTitle('y-theirs'))!;
    await A.rpc('edit', { id: ax.id, title: 'x-from-A', expectedRevision: ax.revision });
    await A.rpc('edit', { id: ay.id, title: 'y-from-A', expectedRevision: ay.revision });
    await B.rpc('edit', { id: x.id, title: 'x-from-B', expectedRevision: x.revision });
    await B.rpc('edit', { id: y.id, title: 'y-from-B', expectedRevision: y.revision });
    // Two queued edits of one item behind a home change: neither may overwrite the home (P1-2).
    const az = (await A.byTitle('b2'))!;
    await A.rpc('edit', { id: az.id, title: 'b2-from-A', expectedRevision: az.revision });
    await B.rpc('edit', { id: z.id, title: 'b2-B-1' });
    await B.rpc('edit', { id: z.id, title: 'b2-B-2' });
    await B.rpc('unblock');
    const conflicts = await waitFor('B records conflicts', async () => {
      const list = await B.rpc('conflicts');
      return list.length === 4 ? list : false;
    }, 40_000);
    check('4a concurrent edit on A and offline B -> conflicts recorded on B (mirror shows A\'s versions)',
      conflicts.length === 4 && (await B.rpc('status')).pending === 0 && (await A.titles()).includes('b2-from-A') && !(await A.titles()).some((t) => t.startsWith('b2-B')),
      { conflicts, A: await A.titles(), B: await B.titles() });
    const cx = conflicts.find((c: any) => c.todoId === x.id);
    const cy = conflicts.find((c: any) => c.todoId === y.id);
    await B.rpc('resolve', { conflictId: cx.id, choice: 'mine' });
    await B.rpc('resolve', { conflictId: cy.id, choice: 'theirs' });
    for (const cz of conflicts.filter((c: any) => c.todoId === z.id)) await B.rpc('resolve', { conflictId: cz.id, choice: 'theirs' });
    await waitFor('resolution settles', async () => {
      const s = await B.rpc('status');
      return s.pending === 0 && s.conflicts === 0 && (await A.titles()).includes('x-from-B');
    }, 40_000);
    const finalA = await A.titles();
    const finalB = await B.titles();
    check('4b resolve mine -> home takes B\'s edit; theirs -> B keeps home\'s; lists converge',
      finalA.includes('x-from-B') && finalA.includes('y-from-A') && finalA.includes('b2-from-A') && JSON.stringify(finalA) === JSON.stringify(finalB),
      { A: finalA, B: finalB });

    // ---------------------------------------------------------------- 5a
    await A.rpc('add', { title: 'a-extra' });
    await B.rpc('setHome');
    await waitFor('A demotes (handover)', async () => {
      const s = await A.rpc('status');
      return s.role === 'replica' && s.homeName === 'dev-B';
    });
    await waitFor('lists converge after handover', async () => JSON.stringify(await A.titles()) === JSON.stringify(await B.titles()));
    check('5a set B home while A online -> A demotes, data intact',
      (await B.rpc('status')).role === 'home' && (await B.titles()).includes('a-extra'),
      { A: await A.rpc('status'), B: await B.rpc('status'), titles: await B.titles() });

    // ---------------------------------------------------------------- 5b
    await A.rpc('setHome');
    await waitFor('B follows A', async () => {
      const s = await B.rpc('status');
      return s.role === 'replica' && s.homeName === 'dev-A';
    });
    await A.rpc('block');
    await waitFor('B sees A offline', async () => !(await B.rpc('ping')).peers.find((p: any) => p.id === 'dev-A')?.online);
    await B.rpc('setHome');
    await A.rpc('add', { title: 'a-offline' });
    check('5b-pre B took over while A offline; A still self-believes home',
      (await B.rpc('status')).role === 'home' && (await A.rpc('status')).role === 'home', { A: (await A.rpc('status')).role, B: (await B.rpc('status')).role });
    await sleep(16_000); // engine's discovery throttle (15 s) since the last reconcile
    await A.rpc('unblock');
    await waitFor('A self-demotes and carries', async () => {
      const s = await A.rpc('status');
      return s.role === 'replica' && s.homeName === 'dev-B' && s.pending === 0 && (await B.titles()).includes('a-offline');
    }, 60_000);
    const bTitles = await B.titles();
    check('5b A returns -> self-demotes, its offline todo carried to B exactly once',
      bTitles.filter((t) => t === 'a-offline').length === 1 && JSON.stringify(await A.titles()) === JSON.stringify(bTitles),
      { A: await A.rpc('status'), B: bTitles });

    // ---------------------------------------------------------------- 7
    const guest = await B.rpc('runAsGuest');
    check('7a different-account (provider-share guest) peer cannot use the channel', guest.ok === false, guest.error ?? guest);
    // A paired phone (same account) must not reach the channel at all, least of all hand the home over.
    const phoneHandover = await M.rpc('probe', { dst: 'dev-B', request: { action: 'handover', dataset: 'personal-todos', newHomeDeviceId: 'dev-M-phone', homeEpoch: 999 } });
    const phoneCaps = await M.rpc('probe', { dst: 'dev-B', request: { action: 'caps' } });
    check('7d same-account phone is refused on the channel; the home stays',
      phoneHandover.ok === false && phoneHandover.error.code === 'CHANNEL_NOT_ALLOWED' && phoneCaps.ok === false && (await B.rpc('status')).role === 'home',
      { handover: phoneHandover.error, caps: phoneCaps.error, bRole: (await B.rpc('status')).role });
    await B.rpc('revoke', { deviceId: 'dev-A', revoked: true });
    const revokedProbe = await A.rpc('probe', { dst: 'dev-B', request: { action: 'caps' } }).catch((error: Error) => ({ ok: false, error: { code: 'THROWN', message: String(error.message).slice(0, 160) } }));
    await A.rpc('edit', { id: (await A.byTitle('a-offline'))!.id, title: 'a-edit-while-revoked' });
    const revokedStatus = await A.rpc('status');
    check('7b revoked device is refused (observed code reported), edit stays pending',
      revokedProbe.ok === false && revokedStatus.pending === 1 && !(await B.titles()).includes('a-edit-while-revoked'),
      { probe: revokedProbe.error, status: revokedStatus });
    await B.rpc('revoke', { deviceId: 'dev-A', revoked: false });
    let natural = true;
    try {
      await waitFor('A flushes after un-revoke (natural backoff)', async () => (await A.rpc('status')).pending === 0, 45_000);
    } catch {
      natural = false;
      await A.rpc('syncNow'); // labelled: the natural retry did not fire within 45 s
      await waitFor('A flushes after explicit syncNow', async () => (await A.rpc('status')).pending === 0, 15_000);
    }
    check('7c after un-revoke the queued edit flushes', (await B.titles()).includes('a-edit-while-revoked'), { naturalRetry: natural, status: await A.rpc('status') });
  } finally {
    for (const d of [A, B, C, M]) if (d.alive) await d.rpc('quit').catch(() => undefined);
    await sleep(300);
    for (const d of [A, B, C, M]) if (d.alive) await d.kill();
    await world.relay.close();
  }
}

async function oldPeerOnlyWorld(bundle: string, temp: string) {
  const world = await startRelay(['dev-P', 'dev-Q-old'], temp);
  const [P, Q] = world.credentials.map((c, i) =>
    new Device(c.deviceId, { bundle, wsUrl: world.wsUrl, credential: c.credential, userData: path.join(temp, `ud2-${c.deviceId}`), old: i === 1 }));
  try {
    await Promise.all([P.start(), Q.start()]);
    await peersSeen(P, ['dev-Q-old']);
    const enabled = await P.rpc('enable');
    const served = (await Q.rpc('counters')).served;
    check('6b only an old peer online: new peer becomes home itself (old peer is not a candidate)', enabled.role === 'home' && Object.keys(served).length === 0, { enabled, served });
  } finally {
    for (const d of [P, Q]) if (d.alive) await d.rpc('quit').catch(() => undefined);
    await sleep(300);
    for (const d of [P, Q]) if (d.alive) await d.kill();
    await world.relay.close();
  }
}

async function main() {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'cindy-shared-datasets-smoke-'));
  const bundle = path.join(temp, 'device.cjs');
  try {
    await buildDeviceBundle(bundle);
    await mainWorld(bundle, temp);
    await oldPeerOnlyWorld(bundle, temp);
  } catch (error) {
    check('harness', false, String((error as Error).stack ?? error).slice(0, 1500));
  } finally {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    if (path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('cindy-shared-datasets-smoke-')) {
      await rm(temp, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

void main();
