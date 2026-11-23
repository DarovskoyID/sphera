const fs = require('node:fs'), crypto = require('node:crypto');
const root = 'D:/sphere-all', out = root + '/output/sdk-replica-20261120';
const trust = JSON.parse(fs.readFileSync(root + '/release/trust.public.json', 'utf8'));
const cert = JSON.parse(fs.readFileSync(root + '/release/delegations/server-release-20261117.json', 'utf8'));
const body = JSON.parse(Buffer.from(cert.payload, 'base64').toString('utf8'));
const rootKey = crypto.createPublicKey({ key: Buffer.from(trust.root_public_key, 'base64'), format: 'der', type: 'spki' });
const canonical = v => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  : JSON.stringify(v);
if (!crypto.verify('sha256', Buffer.from(cert.payload, 'base64'), { key: rootKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(cert.signature, 'base64'))) throw Error('delegation_signature_invalid');
const key = crypto.createPublicKey({ key: Buffer.from(body.public_key, 'base64'), format: 'der', type: 'spki' });
const bundle = JSON.parse(fs.readFileSync(out + '/sdk-enable-v33.json', 'utf8'));
if (JSON.stringify(bundle.certificate) !== JSON.stringify(cert)) throw Error('wrong_delegation');
const raw = Buffer.from(bundle.document.payload, 'base64');
if (!crypto.verify('sha256', raw, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, Buffer.from(bundle.document.signature, 'base64'))) throw Error('signature_invalid');
const doc = JSON.parse(raw.toString('utf8'));
if (canonical(doc) !== raw.toString('ascii') || doc.domain !== 'sphere-point-web-job-v1' || doc.product !== 'sphere' || doc.channel !== trust.channel || !(doc.issued_at < Date.now()/1000 && Date.now()/1000 < doc.expires_at && doc.expires_at <= body.expires_at)) throw Error('manifest_context');
const asset = fs.readFileSync(out + '/sdk-enable-v33.pyz');
if (asset.length !== doc.bootstrap.size || crypto.createHash('sha256').update(asset).digest('hex') !== doc.bootstrap.sha256) throw Error('bundle_digest');
const site = fs.readFileSync(out + '/sdk-web-v33.tar.gz');
if (site.length !== JSON.parse(fs.readFileSync(out + '/sdk-enable-v33-job.json','utf8')).site.size || crypto.createHash('sha256').update(site).digest('hex') !== JSON.parse(fs.readFileSync(out + '/sdk-enable-v33-job.json','utf8')).site.sha256) throw Error('site_digest');
process.stdout.write(JSON.stringify({ signature_valid: true, bootstrap_sha256: doc.bootstrap.sha256, web_sha256: crypto.createHash('sha256').update(site).digest('hex'), expires_at: doc.expires_at }) + '\n');
