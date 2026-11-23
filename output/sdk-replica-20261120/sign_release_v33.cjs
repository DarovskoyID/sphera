const crypto = require('node:crypto');
const chunks = [];
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const values = chunks.join('').trim().split(/\r?\n/);
  if (values.length !== 2) throw new Error('sign_input_count');
  const key = crypto.createPrivateKey({ key: Buffer.from(values[0], 'base64'), format: 'der', type: 'pkcs8' });
  const payload = Buffer.from(values[1], 'base64');
  const signature = crypto.sign('sha256', payload, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  process.stdout.write(JSON.stringify({ payload: payload.toString('base64'), signature: signature.toString('base64') }));
});
