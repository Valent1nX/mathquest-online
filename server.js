const http = require('http');
const crypto = require('crypto');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT || 10000);
const rooms = new Map();

function send(ws, data){
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}
function code(){
  return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0,6);
}
function freshCode(){
  let c; do c=code(); while(rooms.has(c)); return c;
}
function broadcast(room, msg){
  for(const p of room.players) send(p.ws,msg);
}

function cloneBoard(board){
  return Array.isArray(board) ? board.map(row=>Array.isArray(row)?row.slice():row) : null;
}

function validBoard(board){
  return Array.isArray(board) &&
    board.length===8 &&
    board.every(row=>Array.isArray(row)&&row.length===8&&row.every(v=>v===''||v==='r'||v==='y'));
}

/*
  Math Quest — Online Checkers relay server.
  The client keeps the existing checkers rules and sends the resulting board.
  This server handles rooms, player roles, turns and state relay.
*/
const server = http.createServer((req,res)=>{
  if(req.url==='/health'){
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({ok:true,rooms:rooms.size,game:'checkers'}));
    return;
  }
  res.writeHead(404); res.end('Not found');
});

const wss = new WebSocket.Server({server});

function removePlayer(ws){
  for(const [c,room] of rooms){
    const i=room.players.findIndex(p=>p.ws===ws);
    if(i<0) continue;
    room.players.splice(i,1);
    if(room.players.length===0){ rooms.delete(c); return; }
    const other=room.players[0];
    send(other.ws,{type:'error',message:'Інший гравець вийшов із кімнати.'});
    rooms.delete(c);
    return;
  }
}

wss.on('connection', ws=>{
  ws.on('message', raw=>{
    let m;
    try{ m=JSON.parse(raw.toString()); }
    catch{ send(ws,{type:'error',message:'Невірне повідомлення.'}); return; }

    if(m.type==='room'){
      if(m.game!=='ck'){
        send(ws,{type:'error',message:'Цей сервер призначений для онлайн-шашок.'});
        return;
      }

      let c=String(m.code||'').toUpperCase();
      if(m.action==='create') c=freshCode();

      if(!c || !rooms.has(c)){
        if(m.action==='join'){
          send(ws,{type:'error',message:'Кімнату не знайдено.'});
          return;
        }
        if(m.action!=='create'){
          send(ws,{type:'error',message:'Створення кімнати недоступне.'});
          return;
        }
      }

      let room=rooms.get(c);
      if(m.action==='create'){
        room={
          code:c,
          game:'ck',
          players:[],
          board:null,
          turn:'A',
          over:false,
          chain:false
        };
        rooms.set(c,room);
      }

      if(room.game!=='ck'){
        send(ws,{type:'error',message:'Ця кімната для іншої гри.'});
        return;
      }
      if(room.players.length>=2){
        send(ws,{type:'error',message:'Кімната вже заповнена.'});
        return;
      }
      if(room.players.some(p=>p.ws===ws)){
        send(ws,{type:'error',message:'Ти вже в цій кімнаті.'});
        return;
      }

      const role=room.players.length===0?'A':'B';
      const player={ws,role};
      room.players.push(player);
      ws.room=room;
      ws.role=role;

      send(ws,{
        type:m.action==='create'?'roomCreated':'roomJoined',
        game:'ck',code:c,role
      });

      if(room.players.length===1){
        send(ws,{type:'waiting',code:c});
      }else{
        broadcast(room,{type:'roomReady',game:'ck',code:c});
        // Client starts the standard initial checkers board.
        room.board=null;
        room.turn='A';
        room.over=false;
        room.chain=false;
        broadcast(room,{
          type:'checkersState',
          board:null,
          turn:'A',
          over:false,
          chain:false
        });
      }
      return;
    }

    const room=ws.room;
    if(!room || room.game!=='ck'){
      send(ws,{type:'error',message:'Спочатку увійди в кімнату.'});
      return;
    }

    const player=room.players.find(p=>p.ws===ws);
    if(!player){
      send(ws,{type:'error',message:'Гравця не знайдено.'});
      return;
    }

    if(m.type==='checkersState'){
      if(room.players.length!==2 || room.over) return;
      if(player.role!==room.turn) return;

      const board=cloneBoard(m.board);
      if(!validBoard(board)) return;

      const turn=m.turn==='A'||m.turn==='B'?m.turn:room.turn;
      // Accept the client's resulting state and relay it to both players.
      room.board=board;
      room.turn=turn;
      room.over=!!m.over;
      room.chain=!!m.chain;

      broadcast(room,{
        type:'checkersState',
        board:room.board,
        turn:room.turn,
        over:room.over,
        chain:room.chain,
        result:room.over?(player.role==='A'?'win':'lose'):undefined
      });
      return;
    }

    if(m.type==='checkersSync'){
      if(room.players.length!==2) return;
      if(!validBoard(m.board)) return;
      room.board=cloneBoard(m.board);
      room.turn=m.turn==='B'?'B':'A';
      room.over=!!m.over;
      room.chain=!!m.chain;
      broadcast(room,{
        type:'checkersState',
        board:room.board,
        turn:room.turn,
        over:room.over,
        chain:room.chain
      });
      return;
    }
  });

  ws.on('close',()=>removePlayer(ws));
  ws.on('error',()=>removePlayer(ws));
});

setInterval(()=>{
  for(const ws of wss.clients){
    if(ws.readyState===WebSocket.OPEN){
      try{ws.ping();}catch(_){}
    }
  }
},20000);

server.listen(PORT,'0.0.0.0',()=>console.log(`Math Quest checkers server on ${PORT}`));


setInterval(()=>{for(const ws of wss.clients){if(ws.readyState===WebSocket.OPEN){try{ws.ping();}catch(_){}}}},20000);
server.listen(PORT,'0.0.0.0',()=>console.log(`Math Quest online server on ${PORT}`));
