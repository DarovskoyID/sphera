import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context/AppContext';
import { accountBytes, accountDigest, meshUserId } from '../core/mesh/account';
import { applicationKeys } from '../core/mesh/applicationAuth';
import { meshDeviceId, type DeviceEvent } from '../core/mesh/devices';
import { prepareDeviceEnrollment, prepareDeviceRevocation, verifyEnrollmentFile, type EnrollmentCandidate } from '../core/mesh/deviceEnrollment';
import { AccountRecoveryClient } from '../core/mesh/accountRecoveryClient';
import { ENTRY_PIN_KEY, loadEntryPointPin } from '../core/mesh/entryPoint';
type Candidate = EnrollmentCandidate | { event: DeviceEvent };
async function read(file: File | null) {
  if (!file || file.size > 98304) throw new Error('invalid_device_file');
  return JSON.parse(await file.text());
}
function save(name: string, value: unknown) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(value)],{type:'application/json'})),link=document.createElement('a');
  link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function MeshDevices(){
  const {currentServerIP,authToken}=useApp();
  const [deviceFile,setDeviceFile]=useState<File|null>(null),[ownerFile,setOwnerFile]=useState<File|null>(null),[candidateFile,setCandidateFile]=useState<File|null>(null);
  const [password,setPassword]=useState(''),[newPassword,setNewPassword]=useState(''),[savedPassword,setSavedPassword]=useState('');
  const [mode,setMode]=useState<'enroll'|'revoke'|'resume'>('enroll'),[candidate,setCandidate]=useState<Candidate|null>(null);
  const [devices,setDevices]=useState<{id:string;active:boolean}[]>([]),[actorDevice,setActorDevice]=useState(''),[target,setTarget]=useState('');
  const [busy,setBusy]=useState(false),[checked,setChecked]=useState(false),[notice,setNotice]=useState('');
  const revision=useRef(0),working=useRef(false),actor=useRef('');actor.current=JSON.stringify([currentServerIP,authToken]);
  const clear=()=>{revision.current++;setDeviceFile(null);setOwnerFile(null);setCandidateFile(null);setPassword('');setNewPassword('');setSavedPassword('');setCandidate(null);setDevices([]);setTarget('');setActorDevice('');setChecked(false);setNotice('');};
  useEffect(()=>{clear();return()=>{revision.current++;};},[currentServerIP,authToken]);
  useEffect(()=>{const changed=()=>clear(),storage=(e:StorageEvent)=>{if(e.key===null||e.key===ENTRY_PIN_KEY||e.key==='sfera_selected_server')changed();};window.addEventListener('storage',storage);window.addEventListener('sfera-mesh-entry-change',changed);return()=>{window.removeEventListener('storage',storage);window.removeEventListener('sfera-mesh-entry-change',changed);};},[]);
  const run=async(action:'list'|'prepare'|'check'|'publish')=>{
    if(working.current)return;working.current=true;setBusy(true);setNotice('');
    const generation=revision.current,identity=actor.current,pinned=localStorage.getItem(ENTRY_PIN_KEY);
    const guard=()=>generation===revision.current&&identity===actor.current&&pinned===localStorage.getItem(ENTRY_PIN_KEY);
    try{
      const pin=await loadEntryPointPin(localStorage),keys=applicationKeys(await read(deviceFile),currentServerIP);
      if(!pin||pin.url!==new URL(currentServerIP).origin||keys.entry!==pin.nodeId||keys.network!==pin.network)throw new Error('device_context_mismatch');
      const owner=await meshUserId(keys.ownerPublic),device=await meshDeviceId(keys.devicePublic);
      const client=new AccountRecoveryClient({pin,genesis:keys.genesis,owner,device,token:()=>authToken,guard});
      if(action==='check'){
        if(!candidate||!('credentials'in candidate))throw new Error('enrollment_candidate_required');
        const saved=await verifyEnrollmentFile(await read(candidateFile),savedPassword,keys);
        if(await accountDigest(accountBytes(saved))!==await accountDigest(accountBytes(candidate)))throw new Error('saved_device_mismatch');
        if(!guard())throw new Error('cancelled');setChecked(true);setSavedPassword('');setNotice('Сохранённый ключ нового устройства проверен. Можно зарегистрировать его в сети.');
      }else if(action==='publish'){
        if(!candidate||('credentials'in candidate&&!checked))throw new Error('saved_device_required');
        const result=await client.publishDevice(candidate.event);
        if(!guard())throw new Error('cancelled');
        if(result.state==='confirmed'){
          if('credentials'in candidate)save('sphere-new-device-keys.json',candidate.credentials);
          setNotice(candidate.event.body.operation==='enroll'?'Новое устройство подтверждено сетью. Перенесите файл ключей на новое устройство и выберите «Войти с mesh-ключами». Старое устройство пока сохраняет доступ.':'Доступ выбранного устройства отозван сетью.');setCandidate(null);setChecked(false);
        }else setNotice('Заявка отправлена. Подтверждение ещё не получено; повторите проверку той же заявки.');
      }else{
        const head=await client.deviceHead();if(!guard())throw new Error('cancelled');
        setDevices(Object.entries(head.devices).map(([id,state])=>({id,active:state.active})));setActorDevice(device);
        if(action==='list'){setNotice('Список устройств проверен по свежему состоянию сети.');return;}
        if(mode==='resume'){
          const saved=await read(candidateFile) as Candidate;
          if(!saved?.event||!['enroll','revoke'].includes(saved.event.body?.operation))throw new Error('invalid_device_candidate');
          if(saved.event.body.operation==='enroll'&&!('credentials'in saved))throw new Error('device_credentials_required');
          setCandidate(saved);setChecked(false);setNotice('Сохранённая заявка загружена. Новый ключ необходимо повторно проверить паролем.');
        }else{
          const ownerKeys=ownerFile?applicationKeys(await read(ownerFile),currentServerIP):keys;
          for(const field of ['ownerPublic','network','genesis','entry','applicationUser'] as const)if(ownerKeys[field]!==keys[field])throw new Error('owner_file_mismatch');
          const next=mode==='enroll'?await prepareDeviceEnrollment(ownerKeys,password,newPassword,head):{event:await prepareDeviceRevocation(ownerKeys,password,head,target,device)};
          if(!guard())throw new Error('cancelled');save('sphere-device-candidate.json',next);setCandidate(next);setChecked(false);setCandidateFile(null);
          setNotice(mode==='enroll'?'Заявка сохранена. Выберите скачанный файл и проверьте новый пароль перед регистрацией. Корень владельца в новый файл не включён.':'Заявка отзыва сохранена. Проверьте идентификатор выбранного устройства перед публикацией.');
        }
        setPassword('');setNewPassword('');setSavedPassword('');
      }
    }catch{if(guard()){if(action==='check')setChecked(false);setNotice('Операция не завершена. Проверьте файлы, пароль, выбранное устройство и доступность сети. Сохранённую заявку можно загрузить и повторить.');}}
    finally{working.current=false;setBusy(false);}
  };
  return <details style={{marginBlock:20}}><summary>Устройства mesh-аккаунта</summary>
    <p>Сначала зарегистрируйте новый ключ и проверьте вход на новом устройстве. Старый ключ отзывайте из сеанса другого устройства. Ключ владельца хранится отдельно.</p>
    <form onSubmit={e=>{e.preventDefault();void run('prepare');}} style={{display:'grid',gap:12}}>
      <label>Действие с устройством<select disabled={busy||!!candidate} value={mode} onChange={e=>{setMode(e.target.value as typeof mode);setNotice('');}}><option value="enroll">Добавить новое устройство</option><option value="revoke">Отозвать другое устройство</option><option value="resume">Повторить сохранённую заявку устройства</option></select></label>
      <label>Файл текущего устройства<input type="file" required disabled={busy||!!candidate} accept=".json,application/json" onChange={e=>{setDeviceFile(e.target.files?.[0]??null);setDevices([]);setTarget('');}}/></label>
      <button type="button" disabled={busy||!!candidate||!deviceFile} onClick={()=>void run('list')}>Проверить список устройств</button>
      {devices.length>0&&<ul>{devices.map(item=><li key={item.id}>{item.id} · {item.active?'доступ разрешён':'доступ отозван'}{item.id===actorDevice?' · текущее':''}</li>)}</ul>}
      {mode!=='resume'&&<><label>Отдельный файл владельца (если нужен)<input type="file" disabled={busy||!!candidate} accept=".json,application/json" onChange={e=>setOwnerFile(e.target.files?.[0]??null)}/></label><label>Пароль корня владельца<input type="password" required autoComplete="off" disabled={busy||!!candidate} value={password} onChange={e=>setPassword(e.target.value)}/></label></>}
      {mode==='enroll'&&<label>Пароль нового устройства<input type="password" required autoComplete="new-password" disabled={busy||!!candidate} value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></label>}
      {mode==='revoke'&&<label>Устройство для отзыва<select required disabled={busy||!!candidate} value={target} onChange={e=>setTarget(e.target.value)}><option value="">Выберите устройство</option>{devices.filter(item=>item.active&&item.id!==actorDevice).map(item=><option key={item.id} value={item.id}>{item.id}</option>)}</select></label>}
      {mode==='resume'&&<label>Сохранённая заявка устройства<input type="file" required disabled={busy||!!candidate} accept=".json,application/json" onChange={e=>setCandidateFile(e.target.files?.[0]??null)}/></label>}
      <button disabled={busy||!!candidate}>Подготовить заявку устройства</button>
    </form>
    {candidate&&<section aria-label="Подготовленная заявка устройства"><p>{candidate.event.body.operation==='enroll'?'Новый ключ':'Отзываемый ключ'}: {candidate.event.body.device_id}</p>
      {'credentials'in candidate&&<><label>Сохранённый новый ключ устройства<input type="file" disabled={busy} accept=".json,application/json" onChange={e=>{setCandidateFile(e.target.files?.[0]??null);setChecked(false);}}/></label><label>Пароль сохранённого устройства<input type="password" autoComplete="off" disabled={busy} value={savedPassword} onChange={e=>{setSavedPassword(e.target.value);setChecked(false);}}/></label><button disabled={busy||!candidateFile||!savedPassword} onClick={()=>void run('check')}>Проверить сохранённое устройство</button></>}
      <button disabled={busy||('credentials'in candidate&&!checked)} onClick={()=>void run('publish')}>Опубликовать / проверить устройство</button><button disabled={busy} onClick={()=>save('sphere-device-candidate.json',candidate)}>Сохранить заявку ещё раз</button><button disabled={busy} onClick={()=>{setCandidate(null);setChecked(false);setCandidateFile(null);setSavedPassword('');}}>Закрыть заявку устройства</button>
    </section>}
    {notice&&<p role="status">{notice}</p>}
  </details>;
}
