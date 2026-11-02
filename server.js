'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const WIDTH = 960, HEIGHT = 540, TICK = 1000 / 30;
const PUBLIC = path.join(__dirname, 'public');
const ARTIFACTS = [
  {id:'under_dagger', name:'UNDER DAGGER', kind:'passive', description:'視界内の敵へ弾丸が追尾する'},
  {id:'gravity_nail', name:'重力の釘', kind:'active', description:'Q：敵を吸い寄せる重力場を作る'},
  {id:'reverse_hourglass', name:'逆行する砂時計', kind:'active', description:'E：2秒前の位置へ戻る'},
  {id:'mirror', name:'無限反射鏡', kind:'passive', description:'一定間隔で敵弾を反射する'},
  {id:'echo', name:'残響の王冠', kind:'passive', description:'攻撃を少し遅れて複製する'},
  {id:'fracture', name:'複製印', kind:'passive', description:'命中時に小弾が分裂する'},
  {id:'flame', name:'侵食の炎', kind:'passive', description:'攻撃で炎上ダメージを与える'},
  {id:'stitch', name:'縫合する糸', kind:'passive', description:'敵を倒すと少量回復する'},
  {id:'lens', name:'観測者の瞳', kind:'passive', description:'ボスと強敵へのダメージが増加'},
  {id:'static', name:'静電の輪', kind:'passive', description:'近距離の敵を定期的に感電させる'},
  {id:'void', name:'虚無の心臓', kind:'passive', description:'HPが少ないほど攻撃が強くなる'},
  {id:'prism', name:'屈折結晶', kind:'passive', description:'同時に追加の弾丸を発射する'}
];
const ROOMS = new Map();
const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png'};
const server = http.createServer((req,res)=>{
  if(req.url === '/healthz'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,rooms:ROOMS.size}));return;}
  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.resolve(PUBLIC, '.' + (pathname === '/' ? '/index.html' : pathname));
  if(!file.startsWith(PUBLIC + path.sep)){res.writeHead(403);res.end();return;}
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404);res.end('Not found');return;}
    res.writeHead(200,{'Content-Type':mime[path.extname(file)] || 'application/octet-stream','Cache-Control':'no-cache'});
    res.end(data);
  });
});
const wss = new WebSocketServer({server,path:'/ws',maxPayload:4096});
function send(ws,data){if(ws && ws.readyState===1)ws.send(JSON.stringify(data));}
function broadcast(room,data){for(const p of room.players.values())send(p.ws,data);}
function randomCode(){let code;do{code=Math.random().toString(36).slice(2,7).toUpperCase()}while(ROOMS.has(code));return code;}
function randInt(min,max){return Math.floor(Math.random()*(max-min+1))+min;}
function rng(seed){return function(){let t=seed+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};}
function safeName(value){return String(value || '調査員').replace(/[<>&"'\\]/g,'').slice(0,16) || '調査員';}
function within(v,a,b){return Math.max(a,Math.min(b,v));}
function distance(a,b){return Math.hypot(a.x-b.x,a.y-b.y);}
function normalize(x,y){const d=Math.hypot(x,y)||1;return {x:x/d,y:y/d};}
function has(p,id){return p.artifacts.includes(id);}
function newPlayer(ws,name,id){return {ws,id,name:safeName(name),x:WIDTH/2,y:HEIGHT-75,hp:100,maxHp:100,alive:true,downUntil:0,artifacts:[],input:{mx:0,my:0,angle:-Math.PI/2,fire:false},lastShot:0,dashUntil:0,dashReady:0,invulnUntil:0,qReady:0,eReady:0,echo:[],history:[],mirrorReady:0,offer:null,chosen:true};}
function publicPlayer(p){return {id:p.id,name:p.name,x:Math.round(p.x),y:Math.round(p.y),hp:Math.round(p.hp),maxHp:p.maxHp,alive:p.alive,artifacts:p.artifacts,dashReady:p.dashReady,qReady:p.qReady,eReady:p.eReady};}
function roomLobby(room){
  broadcast(room,{type:'lobby',code:room.code,host:room.host,mode:room.mode,players:[...room.players.values()].map(p=>({id:p.id,name:p.name})),started:room.started});
}
function makeRoom(ws,msg){
  if(ws.room)return;
  const mode=['normal','hard','secret'].includes(msg.mode)?msg.mode:'normal';
  if(mode==='secret' && msg.secretUnlocked!==true){send(ws,{type:'error',message:'裏ステージはソロ・ハードクリアと図鑑全コンプが必要です'});return;}
  const code=randomCode();
  const id=Math.random().toString(36).slice(2,10);
  const room={code,host:id,mode,players:new Map(),started:false,everMultiplayer:false,stage:0,limit:mode==='normal'?15:mode==='hard'?20:1,phase:'lobby',phaseUntil:0,seed:randInt(1,999999999),enemies:[],bullets:[],obstacles:[],fields:[],projectileId:1,lastBroadcast:0,tickCount:0,events:[],createdAt:Date.now()};
  room.players.set(id,newPlayer(ws,msg.name,id)); ws.room=room;ws.playerId=id; ROOMS.set(code,room);
  send(ws,{type:'welcome',id,code,artifacts:ARTIFACTS});
  roomLobby(room);
}
function joinRoom(ws,msg){
  if(ws.room)return;
  const room=ROOMS.get(String(msg.code||'').trim().toUpperCase());
  if(!room){send(ws,{type:'error',message:'ルームが見つかりません'});return;}
  if(room.started){send(ws,{type:'error',message:'探索中です。参加は次のルームから可能です'});return;}
  if(room.players.size>=4){send(ws,{type:'error',message:'満員です（最大4人）'});return;}
  const id=Math.random().toString(36).slice(2,10);
  room.players.set(id,newPlayer(ws,msg.name,id)); room.everMultiplayer=true;
  ws.room=room;ws.playerId=id;
  send(ws,{type:'welcome',id,code:room.code,artifacts:ARTIFACTS});roomLobby(room);
}
function obstaclesFor(room){
  const random=rng(room.seed + room.stage*811);
  const result=[];
  const count=3+Math.floor(random()*3);
  for(let i=0;i<count;i++){
    const x=180+Math.floor(random()*600), y=165+Math.floor(random()*185);
    result.push({x,y,w:45+Math.floor(random()*45),h:26+Math.floor(random()*40)});
  }
  return result;
}
function collides(room,x,y,r){
  if(x<28+r||x>WIDTH-28-r||y<60+r||y>HEIGHT-24-r)return true;
  return room.obstacles.some(o=>x+r>o.x&&x-r<o.x+o.w&&y+r>o.y&&y-r<o.y+o.h);
}
function enemy(room,x,y,boss=false,type='crawler',secret=false){
  const hard=room.mode==='hard'||room.mode==='secret';
  const baseHp=boss?(secret?1800:230+room.stage*40):24+room.stage*7;
  const scale=(hard?2:1)*(1+0.5*(room.players.size-1));
  const baseDamage=boss?(secret?20:8+room.stage*1.4):5+room.stage*.75;
  const patterns=secret?['under_dagger','gravity','mirror','echo','rewind','prism']:['fan','radial','aimed','spiral','dash','wall'];
  const random=rng(room.seed + room.stage*199 + (boss?775:randInt(1,9999)));
  const shuffled=[...patterns].sort(()=>random()-.5);
  const hp=Math.round(baseHp*scale);
  return {id:room.projectileId++,x,y,hp,maxHp:hp,r:boss?(secret?43:35):type==='brute'?19:13,boss,secret,type:secret?'the_anomaly':type,damage:Math.round(baseDamage*(hard?2:1)),lastAttack:Date.now()+randInt(700,1800),patternIndex:0,patterns:shuffled,pattern:'',windupUntil:0,burnUntil:0,lastBurn:0,speed:boss?(secret?88:63):type==='brute'?45:85,lastDash:0};
}
function startStage(room){
  room.enemies=[];room.bullets=[];room.fields=[];room.obstacles=obstaclesFor(room);
  for(const p of room.players.values()){
    p.x=WIDTH/2+(Math.random()-.5)*130;p.y=HEIGHT-95;
    if(p.hp<=0){p.hp=35;p.alive=true;}
    p.hp=Math.min(100,p.hp+18);p.downUntil=0;p.history=[];p.echo=[];p.offer=null;p.chosen=true;
  }
  if(room.mode==='secret'){
    room.obstacles=[];room.phase='fakeclear';room.phaseUntil=Date.now()+3500;
    broadcast(room,{type:'fakeclear',message:'SECRET STAGE CLEAR'});
    return;
  }
  room.phase='intro';room.phaseUntil=Date.now()+1600;
  if(room.stage%5===0){
    const b=enemy(room,WIDTH/2,145,true,'boss');
    room.enemies.push(b);
    broadcast(room,{type:'announcement',message:'WARNING — STAGE '+room.stage+' BOSS'});
  }else{
    const r=rng(room.seed+room.stage*104729);
    const count=Math.min(4+Math.floor(room.stage*.72)+room.players.size*2,20);
    for(let i=0;i<count;i++){
      const type=['crawler','sentinel','brute'][Math.floor(r()*3)];
      let x=80+r()*800,y=90+r()*245;
      let attempts=0;while(collides(room,x,y,20)&&attempts++<20){x=70+r()*820;y=85+r()*260;}
      room.enemies.push(enemy(room,x,y,false,type));
    }
    broadcast(room,{type:'announcement',message:'STAGE '+room.stage+' / '+room.limit});
  }
}
function completeRoom(room){
  room.phase='finished';room.started=false;
  const solo=!room.everMultiplayer && room.players.size===1;
  broadcast(room,{type:'complete',mode:room.mode,solo,stage:room.stage,message:room.mode==='secret'?'THE ANOMALY 消滅 — 真のエンディング':(room.mode==='hard'?'HARD MODE CLEAR':'NORMAL MODE CLEAR')});
}
function chooseOffer(room,p,id){
  if(room.phase!=='reward'||!p.offer||p.chosen||!p.offer.includes(id))return;
  p.chosen=true;p.offer=null;
  if(!has(p,id)){p.artifacts.push(id);if(p.artifacts.length>6)p.artifacts.shift();}
  send(p.ws,{type:'discovery',id,owned:p.artifacts});
  if([...room.players.values()].every(q=>q.chosen)){room.stage++;startStage(room);}
}
function rewardStage(room){
  if(room.mode==='secret'||room.stage>=room.limit){completeRoom(room);return;}
  room.phase='reward';room.phaseUntil=Date.now()+28000;
  broadcast(room,{type:'announcement',message:'STAGE '+room.stage+' CLEAR — 遺物を選択'});
  for(const p of room.players.values()){
    const pool=[...ARTIFACTS].sort(()=>Math.random()-.5).slice(0,3).map(a=>a.id);
    p.offer=pool;p.chosen=false;
    send(p.ws,{type:'offer',ids:pool,stage:room.stage});
  }
}
function nearest(room,x,y,ignore){let best=null,bd=Infinity;for(const p of room.players.values()){if(!p.alive||p.id===ignore)continue;const d=Math.hypot(p.x-x,p.y-y);if(d<bd){best=p;bd=d;}}return best;}
function nearestEnemy(room,x,y,range=99999){let best=null,bd=range;for(const e of room.enemies){if(e.hp<=0)continue;const d=Math.hypot(e.x-x,e.y-y);if(d<bd){best=e;bd=d;}}return best;}
function pushShot(room,x,y,vx,vy,team,damage,r=5,split=false,flame=false){
  if(room.bullets.length>=300)return;
  room.bullets.push({id:room.projectileId++,x,y,vx,vy,team,damage,r,ttl:Date.now()+2200,split,flame});
}
function playerFire(room,p,angle,scale=1,echo=false){
  const target=has(p,'under_dagger')?nearestEnemy(room,p.x,p.y,315):null;
  if(target){const angleTo=Math.atan2(target.y-p.y,target.x-p.x);
    let diff=Math.atan2(Math.sin(angleTo-angle),Math.cos(angleTo-angle));
    if(Math.abs(diff)<.72)angle=angleTo;
  }
  const damage=(12+(has(p,'void')&&p.hp<35?9:0))*(has(p,'lens')?1.12:1)*scale;
  pushShot(room,p.x,p.y,Math.cos(angle)*510,Math.sin(angle)*510,p.id,damage,5,has(p,'fracture')&&!echo,has(p,'flame'));
  if(has(p,'prism')&&!echo)pushShot(room,p.x,p.y,Math.cos(angle+.17)*510,Math.sin(angle+.17)*510,p.id,damage*.55,4,false,has(p,'flame'));
  if(has(p,'echo')&&!echo)p.echo.push({at:Date.now()+235,angle});
}
function bossAttack(room,e,target){
  const pattern=e.patterns[e.patternIndex++%e.patterns.length];
  e.pattern=pattern;
  const a=Math.atan2(target.y-e.y,target.x-e.x);
  if(pattern==='radial'||pattern==='prism'||pattern==='mirror'){
    const n=pattern==='prism'?19:15;
    for(let i=0;i<n;i++){const t=i*Math.PI*2/n+(e.patternIndex%3)*.16;pushShot(room,e.x,e.y,Math.cos(t)*240,Math.sin(t)*240,'enemy',e.damage,7);}
  }else if(pattern==='fan'||pattern==='under_dagger'){
    for(let i=-4;i<=4;i++){const t=a+i*.145;pushShot(room,e.x,e.y,Math.cos(t)*310,Math.sin(t)*310,'enemy',e.damage,7);}
  }else if(pattern==='aimed'||pattern==='echo'){
    for(let i=-2;i<=2;i++){const t=a+i*.11;pushShot(room,e.x,e.y,Math.cos(t)*380,Math.sin(t)*380,'enemy',e.damage,6);}
    if(e.secret){for(let i=-1;i<=1;i++){const t=a+i*.27;pushShot(room,e.x,e.y,Math.cos(t)*215,Math.sin(t)*215,'enemy',e.damage,8);}}
  }else if(pattern==='spiral'||pattern==='rewind'){
    for(let i=0;i<24;i++){const t=i*Math.PI*2/24+e.patternIndex*.47;pushShot(room,e.x,e.y,Math.cos(t)*(140+i*5),Math.sin(t)*(140+i*5),'enemy',e.damage,5);}
  }else if(pattern==='wall'||pattern==='gravity'){
    const gap=randInt(2,8);
    for(let i=0;i<11;i++){if(i===gap||i===gap+1)continue;pushShot(room,50+i*86,70,0,270,'enemy',e.damage,9);}
  }else if(pattern==='dash'){
    const dir=normalize(target.x-e.x,target.y-e.y);
    e.x=within(e.x+dir.x*155,80,880);e.y=within(e.y+dir.y*100,110,400);
    for(let i=0;i<10;i++){const t=i*Math.PI*2/10;pushShot(room,e.x,e.y,Math.cos(t)*220,Math.sin(t)*220,'enemy',e.damage,6);}
  }
  broadcast(room,{type:'bossAttack',name:e.secret?'the anomaly':('STAGE '+room.stage+' BOSS'),pattern});
}
function hurtPlayer(room,p,damage){
  if(!p.alive||Date.now()<p.invulnUntil)return;
  if(has(p,'mirror')&&Date.now()>p.mirrorReady){p.mirrorReady=Date.now()+4200;const e=nearestEnemy(room,p.x,p.y,600);if(e){const n=normalize(e.x-p.x,e.y-p.y);pushShot(room,p.x,p.y,n.x*440,n.y*440,p.id,damage*1.3);}return;}
  p.hp=Math.max(0,p.hp-damage);p.invulnUntil=Date.now()+430;
  if(p.hp<=0){p.alive=false;p.downUntil=Date.now()+15000;broadcast(room,{type:'announcement',message:p.name+' がダウン！'});}
}
function damageEnemy(room,e,damage,owner){
  e.hp-=damage;
  if(e.hp<=0){const p=room.players.get(owner);if(p&&has(p,'stitch'))p.hp=Math.min(100,p.hp+4);}
}
function update(room,dt){
  const now=Date.now();
  if(room.phase==='fakeclear'&&now>room.phaseUntil){
    room.phase='descent';room.phaseUntil=now+2200;
    room.enemies=[enemy(room,WIDTH/2,-60,true,'boss',true)];
    broadcast(room,{type:'descent',message:'異常管理社の元代表 — THE ANOMALY'});
    return;
  }
  if(room.phase==='descent'){
    const e=room.enemies[0];if(e)e.y+=(165-e.y)*Math.min(1,dt*2);
    if(now>room.phaseUntil){room.phase='fight';if(e)e.y=165;}
    return;
  }
  if(room.phase==='intro'){if(now>room.phaseUntil)room.phase='fight';else return;}
  if(room.phase==='reward'){
    if(now>room.phaseUntil){for(const p of room.players.values())if(!p.chosen&&p.offer)chooseOffer(room,p,p.offer[0]);}
    return;
  }
  if(room.phase!=='fight')return;
  room.fields=room.fields.filter(f=>f.until>now);
  for(const p of room.players.values()){
    if(!p.alive){
      if(p.downUntil && now>p.downUntil)p.downUntil=0;
      continue;
    }
    const input=p.input;
    const n=normalize(Number(input.mx)||0,Number(input.my)||0);
    const moving=Math.abs(input.mx)+Math.abs(input.my)>.1;
    if(input.dash&&now>p.dashReady){p.dashReady=now+2500;p.dashUntil=now+175;p.invulnUntil=now+275;}
    const speed=now<p.dashUntil?620:220;
    const dx=(moving?n.x:0)*speed*dt,dy=(moving?n.y:0)*speed*dt;
    if(!collides(room,p.x+dx,p.y,14))p.x+=dx;
    if(!collides(room,p.x,p.y+dy,14))p.y+=dy;
    p.history.push({t:now,x:p.x,y:p.y,hp:p.hp});
    while(p.history.length&&p.history[0].t<now-2600)p.history.shift();
    if(input.fire && now-p.lastShot>(has(p,'static')?145:195)){
      p.lastShot=now;playerFire(room,p,Number(input.angle)||0);
    }
    if(input.q&&has(p,'gravity_nail')&&now>p.qReady){
      p.qReady=now+11000;room.fields.push({x:within(p.x+Math.cos(input.angle)*160,60,900),y:within(p.y+Math.sin(input.angle)*160,80,480),until:now+2800});
    }
    if(input.e&&has(p,'reverse_hourglass')&&now>p.eReady){
      p.eReady=now+18000;const old=p.history.find(h=>h.t>=now-2200);
      if(old){p.x=old.x;p.y=old.y;p.hp=Math.min(100,p.hp+Math.min(15,Math.max(0,old.hp-p.hp)));}
    }
    p.echo=p.echo.filter(t=>{if(t.at<=now){playerFire(room,p,t.angle,.38,true);return false;}return true;});
    if(has(p,'static')&&room.tickCount%32===0){for(const e of room.enemies){if(distance(p,e)<105)damageEnemy(room,e,5,p.id);}}
  }
  for(const e of room.enemies){
    if(e.hp<=0)continue;
    const target=nearest(room,e.x,e.y);
    if(!target)continue;
    if(e.burnUntil>now&&now-e.lastBurn>440){e.lastBurn=now;e.hp-=2;}
    if(e.boss){
      if(now>e.lastAttack){
        e.lastAttack=now+(e.secret?2150:2450);
        bossAttack(room,e,target);
      }
      const n=normalize(target.x-e.x,target.y-e.y);
      if(distance(target,e)>170){if(!collides(room,e.x+n.x*e.speed*dt,e.y,35))e.x+=n.x*e.speed*dt;if(!collides(room,e.x,e.y+n.y*e.speed*dt,35))e.y+=n.y*e.speed*dt;}
      continue;
    }
    const n=normalize(target.x-e.x,target.y-e.y);
    let speed=e.speed;for(const f of room.fields)if(distance(e,f)<180){const pull=normalize(f.x-e.x,f.y-e.y);e.x+=pull.x*165*dt;e.y+=pull.y*165*dt;speed*=.4;}
    const stop=e.type==='sentinel'?205:25;
    if(distance(e,target)>stop){if(!collides(room,e.x+n.x*speed*dt,e.y,e.r))e.x+=n.x*speed*dt;if(!collides(room,e.x,e.y+n.y*speed*dt,e.r))e.y+=n.y*speed*dt;}
    if(now>e.lastAttack){
      e.lastAttack=now+(e.type==='sentinel'?1650:1000);
      if(e.type==='sentinel'){
        pushShot(room,e.x,e.y,n.x*300,n.y*300,'enemy',e.damage,6);
      }else if(distance(e,target)<e.r+target.maxHp/6+8){hurtPlayer(room,target,e.damage);}
    }
  }
  const remaining=[];
  for(const b of room.bullets){
    if(b.ttl<now)continue;
    const nx=b.x+b.vx*dt,ny=b.y+b.vy*dt;
    if(collides(room,nx,ny,b.r))continue;
    b.x=nx;b.y=ny;
    let consumed=false;
    if(b.team==='enemy'){
      for(const p of room.players.values()){if(p.alive&&distance(b,p)<b.r+13){hurtPlayer(room,p,b.damage);consumed=true;break;}}
    }else{
      for(const e of room.enemies){
        if(e.hp>0&&distance(b,e)<b.r+e.r){
          damageEnemy(room,e,b.damage,b.team);
          if(b.flame)e.burnUntil=now+1900;
          if(b.split){for(const a of [-.5,.5]){const t=Math.atan2(b.vy,b.vx)+a;pushShot(room,b.x,b.y,Math.cos(t)*350,Math.sin(t)*350,b.team,b.damage*.42,3,false,b.flame);}}
          consumed=true;break;
        }
      }
    }
    if(!consumed)remaining.push(b);
  }
  room.bullets=remaining;
  const aliveEnemies=room.enemies.filter(e=>e.hp>0);
  if(aliveEnemies.length!==room.enemies.length)room.enemies=aliveEnemies;
  const players=[...room.players.values()];
  const canFight=players.some(p=>p.alive);
  if(!canFight){room.phase='failed';room.started=false;broadcast(room,{type:'failed',stage:room.stage});return;}
  if(room.enemies.length===0)rewardStage(room);
}
function state(room){
  return {type:'state',code:room.code,mode:room.mode,stage:room.stage,limit:room.limit,phase:room.phase,players:[...room.players.values()].map(publicPlayer),enemies:room.enemies.map(e=>({id:e.id,x:Math.round(e.x),y:Math.round(e.y),hp:Math.max(0,Math.round(e.hp)),maxHp:e.maxHp,r:e.r,boss:e.boss,secret:e.secret,type:e.type,pattern:e.pattern})),bullets:room.bullets.map(b=>({x:Math.round(b.x),y:Math.round(b.y),r:b.r,team:b.team})),obstacles:room.obstacles,fields:room.fields.map(f=>({x:f.x,y:f.y,r:180})),now:Date.now()};
}
wss.on('connection',ws=>{
  ws.isAlive=true;
  ws.on('message',raw=>{
    let m;try{m=JSON.parse(raw.toString());}catch{return;}
    if(!m||typeof m!=='object')return;
    if(m.type==='create'){makeRoom(ws,m);return;}
    if(m.type==='join'){joinRoom(ws,m);return;}
    const room=ws.room,p=room&&room.players.get(ws.playerId);if(!room||!p)return;
    if(m.type==='start'&&room.host===p.id&&!room.started&&room.phase==='lobby'){room.started=true;room.stage=1;startStage(room);broadcast(room,{type:'started'});}
    if(m.type==='input'&&room.started){
      p.input={mx:within(Number(m.mx)||0,-1,1),my:within(Number(m.my)||0,-1,1),angle:within(Number(m.angle)||0,-100,100),fire:!!m.fire,dash:!!m.dash,q:!!m.q,e:!!m.e};
    }
    if(m.type==='choose')chooseOffer(room,p,String(m.id||''));
  });
  ws.on('close',()=>{
    const room=ws.room;if(!room)return;
    room.players.delete(ws.playerId);
    if(room.players.size===0){ROOMS.delete(room.code);return;}
    if(room.host===ws.playerId)room.host=[...room.players.keys()][0];
    room.everMultiplayer=true;roomLobby(room);
  });
});
setInterval(()=>{
  for(const room of ROOMS.values()){
    room.tickCount++;
    if(room.started)update(room,TICK/1000);
    if(room.started&&room.tickCount%3===0)broadcast(room,state(room));
    if(!room.started&&room.phase!=='lobby'&&Date.now()-room.createdAt>1000*60*90){ROOMS.delete(room.code);}
  }
},TICK);
server.listen(PORT,'0.0.0.0',()=>console.log('Anoartifact listening on '+PORT));
