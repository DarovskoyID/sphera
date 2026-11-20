// Public documents and ciphertext only. Shared by isolated WASM tests.
const assert = require('node:assert/strict');
module.exports = function createRelay(cipherUserId) {
const devices = new Map(), transmissions = [], mailbox = new Map();
function relay(identity) {
  const user = cipherUserId(identity), device = identity.device;
  return async request => {
    transmissions.push(request.body);
    const body = JSON.parse(request.body);
    if (request.type === 0) {
      const key = `${user}/${device}`;
      const stored = devices.get(key) ?? { oneTime: {}, fallback: {} };
      if (body.device_keys) {
        assert.equal(body.device_keys.user_id, user);
        assert.equal(body.device_keys.device_id, device);
        stored.keys = body.device_keys;
      }
      Object.assign(stored.oneTime, body.one_time_keys);
      Object.assign(stored.fallback, body.fallback_keys);
      devices.set(key, stored);
      return JSON.stringify({ one_time_key_counts: { signed_curve25519: Object.keys(stored.oneTime).length } });
    }
    if (request.type === 1) {
      const result = {};
      for (const queried of Object.keys(body.device_keys)) {
        result[queried] = {};
        for (const [key, stored] of devices) {
          if (key.startsWith(queried + '/')) result[queried][stored.keys.device_id] = stored.keys;
        }
      }
      return JSON.stringify({ device_keys: result, failures: {} });
    }
    if (request.type === 2) {
      const result = {};
      for (const [queried, targets] of Object.entries(body.one_time_keys)) {
        result[queried] = {};
        for (const target of Object.keys(targets)) {
          const stored = devices.get(`${queried}/${target}`);
          const key = Object.keys(stored?.oneTime ?? {})[0];
          if (key) {
            result[queried][target] = { [key]: stored.oneTime[key] };
            delete stored.oneTime[key];
          }
        }
      }
      return JSON.stringify({ one_time_keys: result, failures: {} });
    }
    if (request.type === 3) {
      for (const [recipient, targets] of Object.entries(body.messages)) {
        for (const [target, content] of Object.entries(targets)) {
          const key = `${recipient}/${target}`;
          const pending = mailbox.get(key) ?? [];
          pending.push({ sender: user, content });
          mailbox.set(key, pending);
        }
      }
      return '{}';
    }
    throw new Error('Unexpected relay operation');
  };
}

return { relay, devices, transmissions, mailbox };
};
