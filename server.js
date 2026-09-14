const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const INDEX = path.join(__dirname, 'index.html');
const rooms = new Map();

function send(ws, data){ if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }
function code(){ return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0,6); }
function freshCode(){ let c; do c=code(); while(rooms.has(c)); return c; }
function cleanNumber(n){ return Number.isInteger(n) ? n : -1; }

function winTTT(board,size,winLen){
  const lines=[];
  for(let r=0;r<size;r++)for(let c=0;c<=size-winLen;c++){const a=[];for(let k=0;k<winLen;k++)a.push(r*size+c+k);lines.push(a);}
  for(let c=0;c<size;c++)for(let r=0;r<=size-winLen;r++){const a=[];for(let k=0;k<winLen;k++)a.push((r+k)*size+c);lines.push(a);}
  for(let r=0;r<=size-winLen;r++)for(let c=0;c<=size-winLen;c++){const a=[];for(let k=0;k<winLen;k++)a.push((r+k)*size+c+k);lines.push(a);}
  for(let r=0;r<=size-winLen;r++)for(let c=winLen-1;c<size;c++){const a=[];for(let k=0;k<winLen;k++)a.push((r+k)*size+c-k);lines.push(a);}
  for(const l of lines){ if(l.every(i=>board[i]==='X')) return 'X'; if(l.every(i=>board[i]==='O')) return 'O'; }
  return board.every(Boolean) ? 'draw' : null;
}
function broadcastRoom(room, msg){ for(const p of room.players) send(p.ws,msg); }

function validFleet(fleet){
  if(!Array.isArray(fleet) || fleet.length!==4) return false;
  const expected=[3,2,2,1];
  const normalized=fleet.slice().sort((a,b)=>(Array.isArray(b)?b.length:0)-(Array.isArray(a)?a.length:0));
  const seen = new Set();
  const board = new Set();
  for(let i=0;i<normalized.length;i++){
    const cells=normalized[i];
    if(!Array.isArray(cells) || cells.length!==expected[i]) return false;
    if(!cells.every(Number.isInteger)) return false;
    for(const idx of cells){
      if(idx<0 || idx>=64 || board.has(idx)) return false;
      board.add(idx);
    }
    const rs=cells.map(x=>Math.floor(x/8)), cs=cells.map(x=>x%8);
    const sameRow=rs.every(r=>r===rs[0]), sameCol=cs.every(c=>c===cs[0]);
    if(!sameRow && !sameCol) return false;
    const sorted=(sameRow?cs:rs).slice().sort((a,b)=>a-b);
    for(let j=1;j<sorted.length;j++) if(sorted[j]!==sorted[j-1]+1) return false;
    if(new Set(cells).size!==cells.length) return false;
    seen.add(i);
  }
  return seen.size===4;
}
function shipAt(fleet, idx){ return fleet.find(s=>s.cells.includes(idx)); }
function allSunk(fleet){ return fleet.every(s=>s.hits.size===s.cells.length); }
function battleView(room, viewer){
  const me=room.players.find(p=>p.ws===viewer);
  if(!me) return;
  const opp=room.players.find(p=>p!==me);
  send(viewer,{type:'battleState',started:room.started,turn:room.turn,ownShots:Array.from(me.shots),enemyShots:Array.from(me.enemyShots),enemyReady:!!opp?.ready,opponentReady:!!opp?.ready,lastShot:room.lastShot?{role:room.lastShot.role,i:room.lastShot.i,hit:!!room.lastShot.hit,sunk:!!room.lastShot.sunk}:null});
}
function battleBroadcast(room){ for(const p of room.players) battleView(room,p.ws); }
function removePlayer(ws){
  for(const [c,room] of rooms){
    const idx=room.players.findIndex(p=>p.ws===ws);
    if(idx<0) continue;
    room.players.splice(idx,1);
    if(room.players.length===0){rooms.delete(c);continue;}
    const other=room.players[0];
    send(other.ws,{type:'error',message:'Інший гравець вийшов із кімнати.'});
    rooms.delete(c);
    break;
  }
}

const server=http.createServer((req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,rooms:rooms.size}));return;}
  if(req.url==='/' || req.url==='/index.html'){
    fs.createReadStream(INDEX).on('error',()=>{res.writeHead(500);res.end('File error');}).pipe(res);return;
  }
  res.writeHead(404);res.end('Not found');
});

const wss=new WebSocket.Server({server});
wss.on('connection', ws=>{
  ws.on('message', raw=>{
    let m; try{m=JSON.parse(raw.toString())}catch{send(ws,{type:'error',message:'Невірне повідомлення.'});return;}
    if(m.type==='room'){
      const game=m.game==='ttt'?'ttt':m.game==='battle'?'battle':null;
      if(!game){send(ws,{type:'error',message:'Невідома гра.'});return;}
      let c=String(m.code||'').toUpperCase();
      if(m.action==='create') c=freshCode();
      if(!c || !rooms.has(c)){
        if(m.action==='join'){send(ws,{type:'error',message:'Кімнату не знайдено.'});return;}
        if(m.action!=='create'){send(ws,{type:'error',message:'Створення кімнати недоступне.'});return;}
      }
      let room=rooms.get(c);
      if(m.action==='create'){
        const size=game==='ttt'?Math.min(5,Math.max(3,Number(m.settings?.size)||3)):null;
        room={code:c,game,tttSize:size,tttWinLen:game==='ttt'?(size===3?3:4):null,players:[],board:game==='ttt'?Array(size*size).fill(''):null,turn:game==='ttt'?'X':'A',over:false,started:false,lastShot:null};
        rooms.set(c,room);
      }
      if(room.game!==game){send(ws,{type:'error',message:'Ця кімната для іншої гри.'});return;}
      if(room.players.length>=2){send(ws,{type:'error',message:'Кімната вже заповнена.'});return;}
      if(room.players.some(p=>p.ws===ws)){send(ws,{type:'error',message:'Ти вже в цій кімнаті.'});return;}
      const role=game==='ttt'?(room.players.length===0?'X':'O'):(room.players.length===0?'A':'B');
      const player={ws,role,ready:false,fleet:null,shots:new Set(),enemyShots:new Set(),battlePending:false};
      room.players.push(player);ws.room=room;ws.role=role;
      send(ws,{type:m.action==='create'?'roomCreated':'roomJoined',game,code:c,role,size:room.tttSize,winLen:room.tttWinLen});
      if(room.players.length===1) send(ws,{type:'waiting',code:c});
      if(room.players.length===2){
        broadcastRoom(room,{type:'roomReady',game:room.game,code:c,size:room.tttSize,winLen:room.tttWinLen});
        if(game==='ttt') broadcastRoom(room,{type:'tttState',board:room.board,turn:room.turn,over:false,size:room.tttSize,winLen:room.tttWinLen});
        else battleBroadcast(room);
      }
      return;
    }
    const room=ws.room;
    if(!room){send(ws,{type:'error',message:'Спочатку увійди в кімнату.'});return;}
    const player=room.players.find(p=>p.ws===ws);
    if(!player){send(ws,{type:'error',message:'Гравця не знайдено.'});return;}
    if(room.game==='ttt' && m.type==='tttMove'){
      const i=cleanNumber(m.i); if(room.over || room.players.length!==2 || room.turn!==player.role || i<0 || i>=room.board.length || room.board[i]) return;
      room.board[i]=player.role; const w=winTTT(room.board,room.tttSize,room.tttWinLen); 
      if(w){room.over=true;for(const p of room.players)send(p.ws,{type:'tttState',board:room.board,turn:room.turn,over:true,result:w==='draw'?'draw':(p.role===w?'win':'lose'),size:room.tttSize,winLen:room.tttWinLen});}
      else {room.turn=room.turn==='X'?'O':'X';broadcastRoom(room,{type:'tttState',board:room.board,turn:room.turn,over:false,size:room.tttSize,winLen:room.tttWinLen});}
      return;
    }
    if(room.game==='battle' && m.type==='battleReady'){
      if(room.started || player.ready) return;
      if(!validFleet(m.fleet)){send(ws,{type:'error',message:'Неправильна розстановка кораблів.'});return;}
      player.fleet=m.fleet.slice().sort((a,b)=>b.length-a.length).map(cells=>({cells:new Set(cells),hits:new Set()}));player.ready=true;
      if(room.players.length===2 && room.players.every(p=>p.ready)){room.started=true;room.turn='A';room.lastShot=null;}
      battleBroadcast(room);return;
    }
    if(room.game==='battle' && m.type==='battleFire'){
      if(!room.started || room.turn!==player.role || player.battlePending) return;
      const i=cleanNumber(m.i); if(i<0||i>=64||player.shots.has(i))return;
      const opp=room.players.find(p=>p!==player); if(!opp || !opp.fleet)return;
      player.battlePending=true;player.shots.add(i);opp.enemyShots.add(i);
      const ship=shipAt(opp.fleet,i);let hit=false,sunk=false;
      if(ship){ship.hits.add(i);hit=true;sunk=ship.hits.size===ship.cells.size;}
      room.lastShot={role:player.role,i,hit,sunk};
      if(allSunk(opp.fleet)){
        room.started=false;room.over=true;
        player.battlePending=false;send(player.ws,{type:'battleShotAck',i,hit,sunk,turn:player.role});
        send(opp.ws,{type:'battleShotAck',i,hit,sunk,turn:player.role});
        send(player.ws,{type:'battleResult',result:'win'});send(opp.ws,{type:'battleResult',result:'lose'});battleBroadcast(room);return;
      }
      // Classic Battleship: a hit lets the same player continue; a miss passes the turn.
      room.turn=hit?player.role:opp.role;player.battlePending=false;
      send(player.ws,{type:'battleShotAck',i,hit,sunk,turn:room.turn});
      send(opp.ws,{type:'battleShotAck',i,hit,sunk,turn:room.turn});
      battleBroadcast(room);return;
    }
  });
  ws.on('close',()=>removePlayer(ws));
  ws.on('error',()=>removePlayer(ws));
});


setInterval(()=>{for(const ws of wss.clients){if(ws.readyState===WebSocket.OPEN){try{ws.ping();}catch(_){}}}},20000);
server.listen(PORT,'0.0.0.0',()=>console.log(`Math Quest online server on ${PORT}`));

setInterval(()=>{for(const ws of wss.clients){if(ws.readyState===WebSocket.OPEN){try{ws.ping();}catch(_){}}}},20000);
server.listen(PORT,'0.0.0.0',()=>console.log(`Math Quest online server on ${PORT}`));
