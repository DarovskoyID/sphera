/** Explicit consensus command for global one-time-key consumption. */
export type ApplicationKeyBody = {
  domain: 'sfera-mesh-application-key-v1'; network: string; genesis: string;
  owner: string; device: string; devices_version: number; request: string;
  kind: 'upload' | 'fallback' | 'claim'; dialog: string; target_owner: string; target_device: string; keys_utf8: string;
};
export type ApplicationKeyRecord = { body: ApplicationKeyBody; signature: string };

export function validateApplicationKeyBody(value: ApplicationKeyBody) {
  const fields=['domain','network','genesis','owner','device','devices_version','request','kind','dialog','target_owner','target_device','keys_utf8'];
  const hex=/^[0-9a-f]{64}$/;
  if (!value || Object.keys(value).sort().join(',')!==fields.sort().join(',')
      || value.domain!=='sfera-mesh-application-key-v1' || !/^[A-Za-z0-9._-]{1,64}$/.test(value.network)
      || ![value.genesis,value.owner,value.device].every(item=>typeof item==='string' && hex.test(item))
      || !Number.isSafeInteger(value.devices_version) || value.devices_version<1 || value.devices_version>256
      || typeof value.request!=='string' || !/^[A-Za-z0-9._:+/-]{1,128}$/.test(value.request)) throw new Error('application_key_command_context');
  if ((value.kind==='upload' || value.kind==='fallback')) {
    if (value.dialog!=='' || value.target_owner!=='' || value.target_device!=='' || typeof value.keys_utf8!=='string'
        || !/^(?:[0-9a-f]{2}){1,30000}$/.test(value.keys_utf8)) throw new Error('application_key_upload_context');
  } else if (value.kind==='claim') {
    if (![value.dialog,value.target_owner,value.target_device].every(item=>typeof item==='string' && hex.test(item))
        || value.keys_utf8!=='' || value.owner===value.target_owner && value.device===value.target_device) throw new Error('application_key_claim_context');
  } else throw new Error('application_key_command_kind');
}
