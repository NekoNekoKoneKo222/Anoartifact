'use strict';
(() => {
const $=id=>document.getElementById(id);
const canvas=$('game'),ctx=canvas.getContext('2d',{alpha:false});
const WIDTH=960,HEIGHT=540;
const ARTS=[
 ['under_dagger','UNDER DAGGER'],['gravity_nail','重力の釘'],['reverse_hourglass','逆行する砂時計'],
 ['mirror','無限反射鏡'],['echo','残響の王冠'],['fracture','複製印'],
 ['flame','侵食の炎'],['stitch','縫合する糸'],['lens','観測者の瞳'],
 ['static','静電の輪'],['void','虚無の心臓'],['prism','屈折結晶']
];
const DETAILS=Object.fromEntries(ARTS.map(a=>[a[0],{name:a[1],description:''}]));
const PROFILE_KEY='anoartifact_profile_v1';
let profile;
try{profile=JSON.parse(localStorage.getItem(PROFILE_KEY)||'{}');}catch{profile={};}
if(!Array.isArray(profile.discovered))profile.discovered=[];
profile.soloHardClear=!!profile.soloHardClear;
profile.secretCleared=!!profile.secretCleared;
const secretUnlocked=()=>profile.soloHardClear&&ARTS.every(a=>profile.discovered.includes(a[0]));
const save=()=>{try{localStorage.setItem(PROFILE_KEY,JSON.stringify(profile));}catch{}};
let socket=null,connected=false,selfId=null,hostId=null,roomCode='',selectedMode='normal',mode='normal',currentState=null;
let overlayMode='intro',fakeActive=false,lastToastTimeout=0,screenPhase='lobby';
let mouseFire=false,touchFire=false,aim=-Math.PI/2;
const key=new Set();
const joystick={x:0,y:0,pointer:null};
const pulses={dash:false,q:false,e:false};
let visualPlayers=new Map(),visualEnemies=new Map();
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function catalogName(id){return (DETAILS[id]||{}).name||id;}
function showOverlay(markup,variant=''){
  $('screen-overlay').className='screen-overlay '+variant;
  $('modal-content').innerHTML=markup;
  overlayMode=variant||'modal';
}
function hideOverlay(){$('screen-overlay').classList.add('hidden');overlayMode='none';}
function toast(text,ms=2100){
  const el=$('toast');el.textContent=text;el.classList.remove('hidden');
  clearTimeout(lastToastTimeout);lastToastTimeout=setTimeout(()=>el.classList.add('hidden'),ms);
  $('log-text').textContent=text;
}
function flash(text,ms=2500){
  const el=$('flash-title');el.textContent=text;el.classList.remove('hidden');
  setTimeout(()=>{if(el.textContent===text)el.classList.add('hidden');},ms);
}
function updateProgress(){
  const count=ARTS.filter(a=>profile.discovered.includes(a[0])).length;
  $('catalog-number').textContent=count+' / '+ARTS.length;
  $('catalog-fill').style.width=(count/ARTS.length*100)+'%';
  $('catalog-list').replaceChildren();
  ARTS.forEach(([id,name])=>{
    const div=document.createElement('div');
    const seen=profile.discovered.includes(id);
    div.className='catalog-entry'+(seen?' discovered':'');
    div.title=seen?name:'未発見の異常遺物';
    div.textContent=(seen?'◈ ':'◇ ')+(seen?name:'未発見');
    $('catalog-list').appendChild(div);
  });
  const unlocked=secretUnlocked();
  const hard=profile.soloHardClear;
  $('unlock-box').className='unlock-box'+(unlocked?' ok':'');
  $('unlock-box').textContent=(unlocked?'裏ステージ解放済み':'裏ステージ解放条件')+'\n'+(hard?'✓':'□')+' ソロでハード20ステージクリア\n'+(count===ARTS.length?'✓':'□')+' ANOMALY ARTIFACT図鑑全コンプ';
  $('unlock-box').style.whiteSpace='pre-line';
  const btn=$('secret-mode');
  btn.disabled=!unlocked;
  btn.classList.toggle('unlocked',unlocked);
  btn.querySelector('span').textContent=unlocked?'THE ANOMALY':'LOCKED';
  if(!unlocked&&selectedMode==='secret')selectMode('normal');
}
function selectMode(value){
  if(value==='secret'&&!secretUnlocked())return;
  selectedMode=value;
  document.querySelectorAll('.mode').forEach(btn=>btn.classList.toggle('active',btn.dataset.mode===value));
  $('mode-badge').textContent=value==='secret'?'SECRET':value.toUpperCase();
}
document.querySelectorAll('.mode').forEach(b=>b.addEventListener('click',()=>selectMode(b.dataset.mode)));
$('nickname').value=localStorage.getItem('anoartifact_name')||'調査員';
$('nickname').addEventListener('change',()=>{try{localStorage.setItem('anoartifact_name',$('nickname').value.slice(0,16));}catch{}});
function send(msg){if(socket&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify(msg));}
function setConnection(online){
  connected=online;
  $('connection-dot').classList.toggle('online',online);
  $('connection-text').textContent=online?'サーバー接続済み':'通信未接続';
  $('create-room').disabled=!online;
  $('join-room').disabled=!online;
}
function connect(){
  const scheme=location.protocol==='https:'?'wss:':'ws:';
  socket=new WebSocket(scheme+'//'+location.host+'/ws');
  socket.addEventListener('open',()=>{setConnection(true);toast('異常管理社サーバーに接続しました');});
  socket.addEventListener('close',()=>{setConnection(false);toast('サーバーとの接続が切断されました');if(currentState&&currentState.phase==='fight')showOverlay('<h2>通信が切断されました</h2><p>ページを再読み込みして接続し直してください。</p><button onclick="location.reload()">再接続</button>');});
  socket.addEventListener('error',()=>{setConnection(false);});
  socket.addEventListener('message',event=>{let msg;try{msg=JSON.parse(event.data);}catch{return;}handle(msg);});
}
function create(){
  if(!connected)return;
  mode=selectedMode;
  send({type:'create',mode,name:$('nickname').value,secretUnlocked:secretUnlocked()});
}
function join(){
  if(!connected)return;
  const code=$('room-code').value.replace(/[^a-zA-Z0-9]/g,'').toUpperCase();
  if(code.length!==5){toast('5文字のルームコードを入力してください');return;}
  send({type:'join',code,name:$('nickname').value});
}
$('create-room').addEventListener('click',create);
$('join-room').addEventListener('click',join);
$('room-code').addEventListener('keydown',e=>{if(e.key==='Enter')join();});
function lobby(data){
  roomCode=data.code;hostId=data.host;mode=data.mode;
  $('room-badge').textContent='ROOM '+roomCode;
  $('mode-badge').textContent=mode==='secret'?'SECRET':mode.toUpperCase();
  if(data.started){return;}
  const members=data.players.map(p=>'<span>'+esc(p.name)+'</span>').join('');
  const owner=selfId===hostId;
  showOverlay('<div class="tiny-label">ANOMALY MANAGEMENT CORPORATION</div><div class="modal-emblem">◈</div><h2>調査ルーム '+esc(roomCode)+'</h2><p>友達にルームコードを共有してください。<br>参加者 '+data.players.length+' / 4</p><div class="squad">'+members+'</div><p>'+ (owner?'全員が揃ったら出動できます。':'ルーム作成者の出動を待っています。')+'</p>'+(owner?'<button id="start-expedition">出動開始</button>':'<p class="small">出動待機中...</p>'));
  const button=$('start-expedition');
  if(button)button.addEventListener('click',()=>send({type:'start'}));
}
function offer(ids){
  screenPhase='reward';
  const choices=ids.map(id=>{
    const art=DETAILS[id]||{name:id,description:''};
    const seen=profile.discovered.includes(id);
    return '<button class="offer-choice" data-id="'+esc(id)+'"><span>◈ '+(seen?'発見済み':'NEW DISCOVERY')+'</span><strong>'+esc(art.name)+'</strong><span>'+esc(art.description||'特殊な異常効果を獲得します')+'</span></button>';
  }).join('');
  showOverlay('<div class="tiny-label">RECOVERY COMPLETE</div><h2>異常遺物を1つ回収</h2><p>3つから1つ選択してください。装備は最大6つです。</p><div class="reward-list">'+choices+'</div><p class="small">28秒以内に選択しない場合は自動で決まります。</p>');
  document.querySelectorAll('.offer-choice').forEach(btn=>btn.addEventListener('click',()=>{
    send({type:'choose',id:btn.dataset.id});
    showOverlay('<div class="modal-emblem">◈</div><h2>遺物回収完了</h2><p>他の調査員を待っています...</p>');
  }));
}
function complete(msg){
  screenPhase='complete';
  if(msg.mode==='hard'&&msg.solo&&msg.stage===20){profile.soloHardClear=true;save();updateProgress();}
  if(msg.mode==='secret'){profile.secretCleared=true;save();}
  const unlock=secretUnlocked();
  showOverlay('<div class="tiny-label">MISSION COMPLETED</div><div class="modal-emblem">◈</div><h2>'+esc(msg.message)+'</h2><p>到達ステージ：'+msg.stage+'</p><p>'+(msg.mode==='hard'&&msg.solo?'ソロ・ハードモードクリア記録を保存しました。<br>':'')+(unlock?'裏ステージへ出動可能です！':'図鑑の調査記録は端末に保存されています。')+'</p><button id="back-base">異常管理社へ帰還</button>');
  $('back-base').addEventListener('click',()=>location.reload());
}
function failed(msg){
  screenPhase='failed';
  showOverlay('<div class="tiny-label">MISSION TERMINATED</div><div class="modal-emblem" style="color:#e95974">◇</div><h2>調査チーム全滅</h2><p>STAGE '+msg.stage+' で探索失敗。発見済みの遺物図鑑は維持されます。</p><button id="back-base">異常管理社へ帰還</button>');
  $('back-base').addEventListener('click',()=>location.reload());
}
function handle(m){
  if(m.type==='welcome'){
    selfId=m.id;roomCode=m.code;
    if(m.artifacts)for(const art of m.artifacts)DETAILS[art.id]={name:art.name,description:art.description};
    updateProgress();
  }else if(m.type==='lobby'){lobby(m);}
  else if(m.type==='started'){
    screenPhase='fight';
    if(!fakeActive)hideOverlay();
    toast('回収作戦を開始します');
  }else if(m.type==='state'){
    currentState=m;
    screenPhase=m.phase;
    updateHud();
    if((m.phase==='fight'||m.phase==='intro'||m.phase==='descent')&&!fakeActive&&overlayMode!=='none')hideOverlay();
  }else if(m.type==='announcement'){toast(m.message);}
  else if(m.type==='offer'){offer(m.ids);}
  else if(m.type==='discovery'){
    if(!profile.discovered.includes(m.id)){profile.discovered.push(m.id);save();updateProgress();toast('図鑑登録：'+catalogName(m.id));}
  }else if(m.type==='bossAttack'){toast((m.name==='the anomaly'?'THE ANOMALY':m.name)+' / '+m.pattern,1250);}
  else if(m.type==='fakeclear'){
    fakeActive=true;
    showOverlay('<div class="tiny-label">SECRET FLOOR</div><div class="modal-emblem">✓</div><h2>STAGE CLEAR</h2><p>すべての異常を回収しました。任務終了...</p>','fakeclear');
  }else if(m.type==='descent'){
    fakeActive=false;hideOverlay();flash('THE ANOMALY',3200);
    toast('上空から異常体が落下！ 異常管理社の元代表が出現',4200);
  }else if(m.type==='complete')complete(m);
  else if(m.type==='failed')failed(m);
  else if(m.type==='error')toast(m.message,5000);
}
function getSelf(){return currentState?.players?.find(p=>p.id===selfId)||null;}
function updateHud(){
  const s=currentState;if(!s)return;
  $('stage-name').textContent=s.mode==='secret'?'第0階層・封印された経営者':s.stage<=5?'廃棄研究区':s.stage<=10?'歪曲都市':s.stage<=15?'虚無中枢':'異常最深部';
  $('stage-count').textContent=s.mode==='secret'?'裏 STAGE':('STAGE '+s.stage+' / '+s.limit);
  $('mode-badge').textContent=s.mode==='secret'?'SECRET':s.mode.toUpperCase();
  $('enemy-count').textContent=s.phase==='reward'?'回収フェーズ':s.enemies.length+'体の敵を検知';
  const me=getSelf();if(!me)return;
  $('hp-fill').style.width=(me.hp/me.maxHp*100)+'%';
  $('hp-number').textContent=me.hp+' / '+me.maxHp;
  const now=Date.now();
  const qReady=Math.max(0,Math.ceil((me.qReady-now)/1000));
  const eReady=Math.max(0,Math.ceil((me.eReady-now)/1000));
  const dashReady=Math.max(0,Math.ceil((me.dashReady-now)/1000));
  $('q-cd').querySelector('span').textContent=me.artifacts.includes('gravity_nail')?(qReady?qReady+'s':'READY'):'未装備';
  $('e-cd').querySelector('span').textContent=me.artifacts.includes('reverse_hourglass')?(eReady?eReady+'s':'READY'):'未装備';
  $('dash-cd').querySelector('span').textContent=dashReady?dashReady+'s':'READY';
  const equip=$('equipment-items');equip.replaceChildren();
  if(!me.artifacts.length){const sp=document.createElement('span');sp.className='empty';sp.textContent='まだ遺物を所持していません';equip.appendChild(sp);}
  for(const id of me.artifacts){const sp=document.createElement('span');sp.className='chip';sp.textContent='◈ '+catalogName(id);equip.appendChild(sp);}
}
document.addEventListener('keydown',ev=>{
  if(['INPUT','TEXTAREA'].includes(document.activeElement.tagName))return;
  const k=ev.key.toLowerCase();
  if([' ','arrowup','arrowdown','arrowleft','arrowright'].includes(k))ev.preventDefault();
  key.add(k);
  if(k===' '){pulses.dash=true;setTimeout(()=>pulses.dash=false,170);}
  if(k==='q'){pulses.q=true;setTimeout(()=>pulses.q=false,170);}
  if(k==='e'){pulses.e=true;setTimeout(()=>pulses.e=false,170);}
});
document.addEventListener('keyup',ev=>key.delete(ev.key.toLowerCase()));
window.addEventListener('blur',()=>{key.clear();mouseFire=false;touchFire=false;joystick.x=0;joystick.y=0;});
document.addEventListener('visibilitychange',()=>{if(document.hidden){key.clear();mouseFire=false;touchFire=false;joystick.x=joystick.y=0;}});
function angleFromPointer(ev){
  const rect=canvas.getBoundingClientRect();
  const x=(ev.clientX-rect.left)/rect.width*WIDTH, y=(ev.clientY-rect.top)/rect.height*HEIGHT;
  const me=getSelf();if(me)aim=Math.atan2(y-me.y,x-me.x);
}
canvas.addEventListener('pointermove',ev=>{if(ev.pointerType==='mouse'||(ev.pointerType==='touch'&&ev.buttons))angleFromPointer(ev);});
canvas.addEventListener('pointerdown',ev=>{
  if(screenPhase!=='fight')return;
  angleFromPointer(ev);
  canvas.setPointerCapture(ev.pointerId);
  if(ev.pointerType==='mouse')mouseFire=true;else touchFire=true;
  ev.preventDefault();
});
canvas.addEventListener('pointerup',ev=>{if(ev.pointerType==='mouse')mouseFire=false;else touchFire=false;});
canvas.addEventListener('pointercancel',()=>{mouseFire=false;touchFire=false;});
canvas.addEventListener('contextmenu',ev=>ev.preventDefault());
function stickMove(ev){
  const r=$('move-stick').getBoundingClientRect();
  const x=ev.clientX-(r.left+r.width/2),y=ev.clientY-(r.top+r.height/2);
  const max=r.width*.32, d=Math.hypot(x,y);
  joystick.x=d>max?x/d:x/max;joystick.y=d>max?y/d:y/max;
  $('move-nub').style.transform='translate('+(joystick.x*max)+'px,'+(joystick.y*max)+'px)';
}
const stick=$('move-stick');
stick.addEventListener('pointerdown',ev=>{joystick.pointer=ev.pointerId;stick.setPointerCapture(ev.pointerId);stickMove(ev);ev.preventDefault();});
stick.addEventListener('pointermove',ev=>{if(ev.pointerId===joystick.pointer){stickMove(ev);ev.preventDefault();}});
function stickEnd(ev){if(ev.pointerId!==joystick.pointer)return;joystick.pointer=null;joystick.x=joystick.y=0;$('move-nub').style.transform='';}
stick.addEventListener('pointerup',stickEnd);stick.addEventListener('pointercancel',stickEnd);
document.querySelectorAll('.action').forEach(btn=>{
  const action=btn.dataset.action;
  btn.addEventListener('pointerdown',ev=>{
    btn.setPointerCapture(ev.pointerId);
    if(action==='fire')touchFire=true;
    else{pulses[action]=true;setTimeout(()=>pulses[action]=false,170);}
    ev.preventDefault();
  });
  const end=()=>{if(action==='fire')touchFire=false;};
  btn.addEventListener('pointerup',end);btn.addEventListener('pointercancel',end);
});
function autoAim(){
  const me=getSelf(),s=currentState;
  if(!me||!s||!s.enemies.length)return;
  let near=null,d=Infinity;
  for(const e of s.enemies){const q=(e.x-me.x)**2+(e.y-me.y)**2;if(q<d){near=e;d=q;}}
  if(near)aim=Math.atan2(near.y-me.y,near.x-me.x);
}
setInterval(()=>{
  if(!connected||!currentState||!['fight','intro','descent'].includes(currentState.phase))return;
  const x=(key.has('d')||key.has('arrowright')?1:0)-(key.has('a')||key.has('arrowleft')?1:0)+joystick.x;
  const y=(key.has('s')||key.has('arrowdown')?1:0)-(key.has('w')||key.has('arrowup')?1:0)+joystick.y;
  const aimTouch=(matchMedia('(pointer:coarse)').matches&&touchFire);
  if(aimTouch)autoAim();
  send({type:'input',mx:Math.max(-1,Math.min(1,x)),my:Math.max(-1,Math.min(1,y)),angle:aim,fire:mouseFire||touchFire,dash:pulses.dash,q:pulses.q,e:pulses.e});
},50);
function colorForStage(stage){
  if(mode==='secret'||currentState?.mode==='secret')return ['#180f24','#311528','#a73c5a'];
  if(stage<=5)return ['#0a1725','#17324b','#2b5b6d'];
  if(stage<=10)return ['#151127','#2a1a46','#644c9b'];
  if(stage<=15)return ['#101b26','#23404b','#65a2a7'];
  return ['#25101c','#3e182e','#c75660'];
}
function lerpVisual(map,id,x,y){
  let point=map.get(id);
  if(!point){point={x,y};map.set(id,point);}
  else{point.x+=(x-point.x)*.33;point.y+=(y-point.y)*.33;}
  return point;
}
function draw(){
  requestAnimationFrame(draw);
  const s=currentState;
  const stage=s?.stage||0;
  const palette=colorForStage(stage);
  const bg=ctx.createLinearGradient(0,0,WIDTH,HEIGHT);
  bg.addColorStop(0,palette[0]);bg.addColorStop(.75,palette[1]);bg.addColorStop(1,palette[0]);
  ctx.fillStyle=bg;ctx.fillRect(0,0,WIDTH,HEIGHT);
  ctx.save();
  ctx.strokeStyle='#a7cde209';ctx.lineWidth=1;
  for(let x=28;x<WIDTH;x+=37){ctx.beginPath();ctx.moveTo(x,60);ctx.lineTo(x,HEIGHT-25);ctx.stroke();}
  for(let y=60;y<HEIGHT;y+=37){ctx.beginPath();ctx.moveTo(28,y);ctx.lineTo(WIDTH-28,y);ctx.stroke();}
  ctx.strokeStyle=palette[2];ctx.lineWidth=4;ctx.strokeRect(28,60,WIDTH-56,HEIGHT-84);
  ctx.fillStyle='#a8c9e514';ctx.fillRect(29,61,WIDTH-58,8);
  ctx.fillStyle='#edf6ff12';ctx.font='700 12px sans-serif';ctx.fillText('ANOMALY MANAGEMENT CORPORATION // SITE '+String(stage||'00').padStart(2,'0'),42,40);
  if(!s){
    ctx.save();ctx.textAlign='center';ctx.fillStyle='#69c1e847';ctx.font='800 140px sans-serif';ctx.fillText('◈',WIDTH/2,305);ctx.font='13px sans-serif';ctx.fillStyle='#8eb3ce';ctx.fillText('異常管理社 — 出動待機',WIDTH/2,355);ctx.restore();ctx.restore();return;
  }
  for(const o of s.obstacles){
    ctx.fillStyle='#0a1121';ctx.fillRect(o.x+4,o.y+5,o.w,o.h);
    ctx.fillStyle='#2e4964';ctx.fillRect(o.x,o.y,o.w,o.h);
    ctx.fillStyle='#517a90';ctx.fillRect(o.x,o.y,o.w,6);
    ctx.strokeStyle='#8ac9e04d';ctx.lineWidth=1;ctx.strokeRect(o.x+.5,o.y+.5,o.w-1,o.h-1);
  }
  for(const field of s.fields){
    const g=ctx.createRadialGradient(field.x,field.y,5,field.x,field.y,field.r);
    g.addColorStop(0,'#8a52ef77');g.addColorStop(1,'#8241f000');
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(field.x,field.y,field.r,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle='#a877ef88';ctx.beginPath();ctx.arc(field.x,field.y,field.r*.65,0,Math.PI*2);ctx.stroke();
  }
  for(const b of s.bullets){
    ctx.shadowBlur=12;ctx.shadowColor=b.team==='enemy'?'#f45b8f':'#64e5ff';
    ctx.fillStyle=b.team==='enemy'?'#ff6488':'#84f3ff';
    ctx.beginPath();ctx.arc(b.x,b.y,b.r,0,Math.PI*2);ctx.fill();
  }ctx.shadowBlur=0;
  const enemyIds=new Set();
  for(const e of s.enemies){
    enemyIds.add(e.id);const v=lerpVisual(visualEnemies,e.id,e.x,e.y),x=v.x,y=v.y,r=e.r;
    ctx.save();ctx.translate(x,y);
    ctx.shadowBlur=e.boss?35:15;ctx.shadowColor=e.secret?'#ff4666':e.boss?'#d959c4':'#df647d';
    ctx.fillStyle=e.secret?'#180d1c':e.boss?'#382348':e.type==='sentinel'?'#824f69':e.type==='brute'?'#6b4167':'#5a3347';
    ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fill();ctx.lineWidth=e.boss?5:2;ctx.strokeStyle=e.secret?'#fe3e63':e.boss?'#d56efa':'#ed869f';ctx.stroke();
    ctx.shadowBlur=0;
    if(e.secret){
      ctx.strokeStyle='#ff547b';ctx.lineWidth=3;
      for(let i=0;i<6;i++){const a=(i/6)*Math.PI*2+Date.now()/1100;ctx.beginPath();ctx.moveTo(Math.cos(a)*50,Math.sin(a)*50);ctx.lineTo(Math.cos(a)*70,Math.sin(a)*70);ctx.stroke();}
      ctx.fillStyle='#ff415e';ctx.fillRect(-18,-5,14,8);ctx.fillRect(4,-5,14,8);
    }else{
      ctx.fillStyle='#ffa7d4';ctx.fillRect(-r*.4,-4,7,6);ctx.fillRect(r*.4-7,-4,7,6);
    }
    ctx.restore();
    ctx.fillStyle='#080e1e';ctx.fillRect(x-r,y-r-13,r*2,5);
    ctx.fillStyle=e.boss?'#ed6599':'#dd737b';ctx.fillRect(x-r,y-r-13,r*2*Math.max(0,e.hp/e.maxHp),5);
    if(e.boss){
      ctx.save();ctx.textAlign='center';ctx.fillStyle=e.secret?'#ff9aa9':'#f8c1e6';ctx.font='800 13px sans-serif';ctx.fillText(e.secret?'THE ANOMALY':('BOSS — '+e.pattern.toUpperCase()),x,y-r-20);ctx.restore();
    }
  }
  for(const id of visualEnemies.keys())if(!enemyIds.has(id))visualEnemies.delete(id);
  const playerIds=new Set();
  for(const p of s.players){
    playerIds.add(p.id);const v=lerpVisual(visualPlayers,p.id,p.x,p.y);
    ctx.save();ctx.translate(v.x,v.y);ctx.globalAlpha=p.alive?1:.42;
    const self=p.id===selfId;ctx.shadowBlur=17;ctx.shadowColor=self?'#51caff':'#b0fba5';
    ctx.fillStyle=self?'#3c8aca':'#57967f';ctx.fillRect(-12,-13,24,26);ctx.fillStyle='#d5efff';ctx.fillRect(-10,-19,20,11);
    ctx.fillStyle='#071b38';ctx.fillRect(-8,-16,16,5);ctx.shadowBlur=0;
    ctx.strokeStyle=self?'#83dcff':'#b6ffd3';ctx.lineWidth=2;ctx.strokeRect(-12,-13,24,26);
    if(self){ctx.strokeStyle='#71cbff44';ctx.beginPath();ctx.arc(0,0,23,0,Math.PI*2);ctx.stroke();}
    ctx.restore();
    ctx.textAlign='center';ctx.fillStyle='#e8faff';ctx.font='11px sans-serif';ctx.fillText(p.name,v.x,v.y-31);
    ctx.fillStyle='#0b162a';ctx.fillRect(v.x-20,v.y+20,40,4);ctx.fillStyle=p.alive?'#6fe4bb':'#ef5d70';ctx.fillRect(v.x-20,v.y+20,40*Math.max(0,p.hp/p.maxHp),4);
  }
  for(const id of visualPlayers.keys())if(!playerIds.has(id))visualPlayers.delete(id);
  const boss=s.enemies.find(e=>e.boss);
  if(boss&&s.phase==='fight'){
    const max=330,bx=(WIDTH-max)/2;
    ctx.fillStyle='#000a';ctx.fillRect(bx,9,max,9);
    ctx.fillStyle=boss.secret?'#f43a62':'#b25bdd';ctx.fillRect(bx,9,max*boss.hp/boss.maxHp,9);
  }
  if(s.phase==='intro'){
    ctx.textAlign='center';ctx.fillStyle='#8fe3ff';ctx.font='900 32px sans-serif';ctx.fillText(s.stage%5===0?'BOSS FLOOR':'STAGE '+s.stage,WIDTH/2,HEIGHT/2+55);
  }
  ctx.restore();
}
function onResize(){/* Canvas uses a fixed logical resolution and responsive CSS dimensions. */}
window.addEventListener('resize',onResize);
updateProgress();selectMode('normal');setConnection(false);connect();requestAnimationFrame(draw);
})();