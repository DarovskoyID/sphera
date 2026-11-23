const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = 'D:/sphere-all';
const out = root + '/output/sdk-replica-20261120';
const base = 'https://github.com/DarovskoyID/sphera/releases/download/wan-trial-20261118/';
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
const meta = file => { const raw = fs.readFileSync(file); return { url: base + path.basename(file), size: raw.length, sha256: sha(raw) }; };
const files = {};
const walk = dir => { for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
  const full = path.join(dir, item.name);
  if (item.isDirectory()) walk(full); else files[path.relative(root + '/dist', full).replaceAll('\\', '/')] = sha(fs.readFileSync(full));
} };
walk(root + '/dist');
const names = Object.keys(files).sort();
const site = out + '/sdk-web-v33.tar.gz';
const tar = spawnSync('tar.exe', ['-czf', site, '-C', root + '/dist', ...names], { stdio: 'inherit' });
if (tar.status !== 0) throw new Error('tar_build_failed');
const previous = JSON.parse(fs.readFileSync(out + '/sdk-enable-v32-job.json', 'utf8'));
const job = { ...previous, site: meta(site), files };
fs.writeFileSync(out + '/sdk-enable-v33-job.json', JSON.stringify(job, Object.keys(job).sort()));
// Recursively canonical JSON, required by the signed manifest verifier.
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  : JSON.stringify(value);
fs.writeFileSync(out + '/sdk-enable-v33-job.json', canonical(job));
const stage = out + '/sdk-enable-v33-stage';
fs.mkdirSync(stage, { recursive: true });
const old = spawnSync('tar.exe', ['-xOf', out + '/sdk-enable-v32.pyz', '__main__.py'], { encoding: 'buffer' });
if (old.status !== 0) throw new Error('installer_extract_failed');
fs.writeFileSync(stage + '/__main__.py', old.stdout);
fs.copyFileSync(out + '/sdk-enable-v33-job.json', stage + '/job.json');
const zip = out + '/sdk-enable-v33.pyz';
if (fs.existsSync(zip)) fs.unlinkSync(zip);
const ps = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open('${zip.replaceAll("'", "''")}',[IO.Compression.ZipArchiveMode]::Create); try { foreach($n in @('__main__.py','job.json')) { [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z,'${stage.replaceAll("'", "''")}\\'+$n,$n,[IO.Compression.CompressionLevel]::Optimal) | Out-Null } } finally { $z.Dispose() }`;
const zipped = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'inherit' });
if (zipped.status !== 0) throw new Error('zip_build_failed');
const trust = JSON.parse(fs.readFileSync(root + '/release/trust.public.json', 'utf8'));
const cert = JSON.parse(fs.readFileSync(root + '/release/delegations/server-release-20261117.json', 'utf8'));
const delegation = JSON.parse(Buffer.from(cert.payload, 'base64').toString('utf8'));
const now = Math.floor(Date.now() / 1000), expires = Math.min(now + 86300, delegation.expires_at);
const body = { domain: 'sphere-point-web-job-v1', product: 'sphere', channel: trust.channel,
  issued_at: now - 10, expires_at: expires, bootstrap: meta(zip) };
fs.writeFileSync(out + '/sdk-enable-v33-sign-payload.json', canonical(body));
console.log(JSON.stringify({ site: meta(site), bundle: meta(zip), expires_at: expires }));
