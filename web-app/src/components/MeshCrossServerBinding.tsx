import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { applicationKeys } from '../core/mesh/applicationAuth';
import { approveServerBinding, CrossServerBindingClient, recoverBindingCredentials, verifyBindingRequest, type PendingBinding } from '../core/mesh/crossServerBinding';
import { ENTRY_PIN_KEY, loadEntryPointPin } from '../core/mesh/entryPoint';
async function read(file:File|null){if(!file||file.size>98304)throw new Error('binding_file_required');return JSON.parse(await file.text());}
function save(name:string,value:unknown){const url=URL.createObjectURL(new Blob([JSON.stringify(value)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function MeshCrossServerBinding(){
  const {currentServerIP,authToken,setAuthToken}=useApp();
  const [mode,setMode]=useState<'prepare'|'approve'|'complete'>('prepare');
  const [keysFile,setKeysFile]=useState<File|null>(null),[requestFile,setRequestFile]=useState<File|null>(null),[approvalFile,setApprovalFile]=useState<File|null>(null);
  const [password,setPassword]=useState(''),[reviewed,setReviewed]=useState(false),[pending,setPending]=useState<PendingBinding|null>(null);
  const [preview,setPreview]=useState<{server:string;user:string;device:string;expires:number}|null>(null),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const revision=useRef(0),working=useRef(false),actor=useRef('');actor.current=JSON.stringify([currentServerIP,authToken]);
  const clear=()=>{revision.current++;setKeysFile(null);setRequestFile(null);setApprovalFile(null);setPassword('');setReviewed(false);setPending(null);setPreview(null);setNotice('');};
  useEffect(()=>{clear();return()=>{revision.current++;};},[currentServerIP,authToken]);
  useEffect(()=>{const change=()=>clear(),storage=(e:StorageEvent)=>{if(e.key===null||e.key===ENTRY_PIN_KEY||e.key==='sfera_selected_server')change();};window.addEventListener('storage',storage);window.addEventListener('sfera-mesh-entry-change',change);return()=>{window.removeEventListener('storage',storage);window.removeEventListener('sfera-mesh-entry-change',change);};},[]);
  const run=async(inspect=false,extract=false)=>{
    if(working.current)return;working.current=true;setBusy(true);setNotice('');const generation=revision.current,identity=actor.current,pinText=localStorage.getItem(ENTRY_PIN_KEY);
    const guard=()=>generation===revision.current&&identity===actor.current&&pinText===localStorage.getItem(ENTRY_PIN_KEY);
    try{
      const pin=await loadEntryPointPin(localStorage);if(!pin||pin.url!==new URL(currentServerIP).origin)throw new Error('binding_trusted_target_required');
      const client=new CrossServerBindingClient({pin,token:()=>authToken,guard});
      if(mode==='prepare'){
        const source=await read(keysFile),keys=applicationKeys(source,source.server),result=await client.prepare(keys,password);
        if(!guard())throw new Error('cancelled');save('sphere-binding-request.json',result);setPending(result);const c=result.request.entry.body.challenge;setPreview({server:pin.url,user:c.application_user,device:c.device,expires:c.expires_at});setNotice('Запрос сохранён. На устройстве владельца выберите тот же доверенный сервер, сверьте показанные реквизиты и сохраните одобрение. Запрос действует не более минуты.');
      }else{
        const loaded=await read(requestFile) as PendingBinding;
        if(extract){const keys=await recoverBindingCredentials(loaded,pin,password);if(!guard())throw new Error('cancelled');save('sphere-server-device-keys.json',keys);setPassword('');setNotice('Файл ключей этого сервера сохранён. Он подходит для обычного входа, если привязка уже была подтверждена сервером.');return;}
        const request=await verifyBindingRequest(loaded.request,pin),c=request.entry.body.challenge;
        if(inspect){if(!guard())throw new Error('cancelled');setPreview({server:pin.url,user:c.application_user,device:c.device,expires:c.expires_at});setReviewed(false);setNotice('Подписи сервера и устройства проверены. Сверьте адрес, пользователя и устройство перед одобрением.');return;}
        if(mode==='approve'){
          if(!preview||!reviewed)throw new Error('binding_review_required');
          if(preview.server!==pin.url||preview.user!==c.application_user||preview.device!==c.device||preview.expires!==c.expires_at)throw new Error('binding_request_changed');
          const source=await read(keysFile),keys=applicationKeys(source,source.server),approval=await approveServerBinding(request,pin,keys,password);
          if(!guard())throw new Error('cancelled');save('sphere-binding-approval.json',approval);setReviewed(false);setNotice('Одобрение сохранено. Передайте его новому устройству. Корень владельца в одобрение не включён.');
        }else{
          const result=await client.complete(loaded,await read(approvalFile),password,keys=>{if(!guard())throw new Error('cancelled');save('sphere-server-device-keys.json',keys);});
          if(!guard())throw new Error('cancelled');setAuthToken(result.access);
        }
      }
      setPassword('');
    }catch{if(guard())setNotice('Привязка не завершена. Проверьте выбранный сервер, файлы, пароль и срок запроса. После потери ответа попробуйте обычный вход device-ключом; старый запрос не отправляется повторно автоматически.');}
    finally{working.current=false;setBusy(false);}
  };
  return <details style={{marginBlock:20}}><summary>Привязать устройство к другому серверу</summary>
    <p>На новом устройстве войдите обычным способом в аккаунт выбранного доверенного сервера. Запрос подтверждается отдельно на устройстве владельца. Его корень переносить не требуется.</p>
    <form onSubmit={e=>{e.preventDefault();void run();}} style={{display:'grid',gap:12}}>
      <label>Этап привязки<select disabled={busy} value={mode} onChange={e=>{setMode(e.target.value as typeof mode);clear();}}><option value="prepare">Подготовить запрос на новом устройстве</option><option value="approve">Одобрить на устройстве владельца</option><option value="complete">Завершить на новом устройстве</option></select></label>
      {mode!=='complete'&&<label>{mode==='approve'?'Файл корня владельца':'Файл ключей устройства с прежнего сервера'}<input disabled={busy} type="file" accept=".json,application/json" required onChange={e=>{setKeysFile(e.target.files?.[0]??null);setReviewed(false);}}/></label>}
      {mode!=='prepare'&&<label>Сохранённый запрос привязки<input disabled={busy} type="file" accept=".json,application/json" required onChange={e=>{setRequestFile(e.target.files?.[0]??null);setPreview(null);setReviewed(false);}}/></label>}
      {mode==='approve'&&<><button type="button" disabled={busy||!requestFile} onClick={()=>void run(true)}>Проверить запрос привязки</button>{preview&&<section aria-label="Проверенный запрос привязки"><p>Сервер: {preview.server}</p><p>Пользователь: {preview.user}</p><p>Устройство: {preview.device}</p><p>Действует до: {new Date(preview.expires*1000).toLocaleTimeString()}</p><label><input type="checkbox" disabled={busy} checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>Я сверил сервер, пользователя и устройство</label></section>}</>}
      {mode==='complete'&&<label>Одобрение владельца<input disabled={busy} type="file" accept=".json,application/json" required onChange={e=>setApprovalFile(e.target.files?.[0]??null)}/></label>}
      {mode==='complete'&&<button type="button" disabled={busy||!requestFile||!password} onClick={()=>void run(false,true)}>Извлечь ключ этого сервера из запроса</button>}
      <label>{mode==='approve'?'Пароль корня владельца':'Пароль файла устройства'}<input disabled={busy} type="password" autoComplete="off" required value={password} onChange={e=>setPassword(e.target.value)}/></label>
      <button disabled={busy||(mode==='approve'&&(!preview||!reviewed))}>{busy?'Проверка…':mode==='prepare'?'Сохранить запрос привязки':mode==='approve'?'Сохранить одобрение владельца':'Завершить привязку сервера'}</button>
    </form>
    {mode==='prepare'&&preview&&<section aria-label="Реквизиты запроса нового устройства"><p>Сервер: {preview.server}</p><p>Пользователь: {preview.user}</p><p>Устройство: {preview.device}</p><p>Действует до: {new Date(preview.expires*1000).toLocaleTimeString()}</p></section>}
    {pending&&<><button disabled={busy} onClick={()=>save('sphere-binding-request.json',pending)}>Сохранить запрос ещё раз</button><button disabled={busy} onClick={()=>save('sphere-server-device-keys.json',pending.credentials)}>Сохранить ключ этого сервера</button></>}
    {notice&&<p role="status">{notice}</p>}
  </details>;
}
