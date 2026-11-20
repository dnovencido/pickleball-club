const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { performance } = require('node:perf_hooks');
const engine = require('./public/engine');
const netcode = require('./public/netcode');
const app = express();
const server = http.createServer({noDelay: true}, app);
const io = new Server(server);
app.use(express.static('public'));
const rooms = new Map();
let queue = null;
function code() { let c; do { c = Array.from({length:4}, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random()*32)]).join(''); } while(rooms.has(c)); return c; }
function cleanProfile(p={}) { return {name:String(p.name||'PLAYER').slice(0,18),badge:/^player-(0[1-9]|1[0-2])$/.test(p.badge)?p.badge:'player-01',color:/^#[0-9a-f]{6}$/i.test(p.color)?p.color:'#d4fa62',skin:['Classic Wood','Carbon Fiber','Neon Cyber','Retro Pixel','Gold Pro'].includes(p.skin)?p.skin:'Classic Wood'}; }
function lobbyUpdate(code,room){room.ids.forEach((id,index)=>io.to(id).emit('lobbyUpdate',{code,index,isHost:id===room.hostId,players:room.profiles.map((profile,i)=>({profile,ready:!!room.ready[i],isHost:room.ids[i]===room.hostId})),messages:room.messages||[],settings:room.settings}));}
function publicState(game,ack=0){return{tick:game.tick,phase:game.phase,message:game.message,score:[...game.score],server:game.server,serveSide:game.serveSide,rallyHits:game.rallyHits,winningScore:game.winningScore,powerUps:game.powerUps,finished:game.finished,event:game.event,ack,ball:{...game.ball},players:game.players.map(p=>({x:p.x,y:p.y,side:p.side,name:p.name,badge:p.badge,color:p.color,skin:p.skin,stamina:p.stamina,swing:p.swing,giant:p.giant,speed:p.speed,frozen:p.frozen,cooldown:p.cooldown,curve:p.curve,freezeShot:p.freezeShot})),orb:game.orb?{...game.orb}:null}}
function startMatch(code, room) {
  room.rematchReady = room.ids.map(() => false);
  room.game = engine.create({players:room.profiles, ...room.settings});
  room.streams = room.ids.map(id => {
    const version = io.sockets.sockets.get(id)?.handshake.auth?.netcode;
    return version === 2 ? new netcode.InputQueue() : null;
  });
  room.events = [];
  room.dirty = room.reliable = false;
  room.inputs = [{},{}];
  room.pendingSwing = [false,false];
  room.lastInputSeq = [0,0];
  const state = publicState(room.game);
  room.ids.forEach(id => io.to(id).emit('matchStart', {code, state, private:room.private}));
}
function leave(socket) { if(queue===socket.id)queue=null; const roomCode=socket.data.room,room=rooms.get(roomCode); if(!room)return; const index=room.ids.indexOf(socket.id); if(index>=0){room.ids.splice(index,1);room.profiles.splice(index,1);room.ready.splice(index,1);} socket.leave(roomCode);socket.data.room=null;if(room.ids.length){const wasPlaying=!!room.game;room.game=null;room.ready=room.ids.map(()=>false);room.messages=[];if(room.hostId===socket.id)room.hostId=room.ids[0];if(wasPlaying)io.to(room.ids[0]).emit('opponentLeft');if(room.private)lobbyUpdate(roomCode,room);} else rooms.delete(roomCode); }
function join(socket, roomCode, profile) { const room=rooms.get(roomCode); if(!room || room.ids.length>=2||socket.data.room===roomCode){socket.emit('roomError','Room not found or already full.');return false} leave(socket); room.ids.push(socket.id); room.profiles.push(cleanProfile(profile));room.ready.push(false); socket.data.room=roomCode; socket.join(roomCode); socket.emit('joined',{code:roomCode,index:room.ids.length-1});if(room.private)lobbyUpdate(roomCode,room);else if(room.ids.length===2)startMatch(roomCode,room);return true; }
io.on('connection', socket=>{
 socket.on('latencyCheck',ack=>{if(typeof ack==='function')ack()});
 socket.on('createRoom',({profile,settings}={})=>{leave(socket);let c=code();rooms.set(c,{ids:[],profiles:[],ready:[],messages:[],private:true,hostId:socket.id,settings:{winningScore:settings?.winningScore===11?11:7,powerUps:!!settings?.powerUps}});join(socket,c,profile)});
 socket.on('joinRoom',({code,profile}={})=>join(socket,String(code||'').toUpperCase().slice(0,4),profile));
 socket.on('quickMatch',({profile,settings}={})=>{leave(socket); if(queue&&queue!==socket.id&&io.sockets.sockets.has(queue)){let first=io.sockets.sockets.get(queue);queue=null;join(socket,first.data.room,profile)}else{let c=code();rooms.set(c,{ids:[],profiles:[],ready:[],private:false,settings:{winningScore:settings?.winningScore===11?11:7,powerUps:!!settings?.powerUps}});join(socket,c,profile);queue=socket.id;socket.emit('searching')}});
socket.on('setReady',ready=>{const room=rooms.get(socket.data.room);if(!room?.private||room.game||typeof ready!=='boolean'||room.hostId===socket.id)return;const i=room.ids.indexOf(socket.id);if(i<0)return;room.ready[i]=ready;lobbyUpdate(socket.data.room,room)});
socket.on('startRoom',()=>{const room=rooms.get(socket.data.room);if(!room?.private||room.game||room.hostId!==socket.id||room.ids.length!==2)return;const opponentIndex=room.ids.findIndex(id=>id!==room.hostId);if(opponentIndex<0||!room.ready[opponentIndex])return;startMatch(socket.data.room,room)});
 socket.on('lobbyChat',payload=>{const room=rooms.get(socket.data.room),index=room?.ids.indexOf(socket.id),text=String(payload?.text||'').trim().replace(/\s+/g,' ').slice(0,240);if(!room?.private||room.game||index<0||!text)return;const message={id:Date.now().toString(36)+Math.random().toString(36).slice(2,7),senderId:socket.id,name:room.profiles[index].name,text};room.messages=(room.messages||[]).slice(-49);room.messages.push(message);io.to(socket.data.room).emit('lobbyChat',message)});
 socket.on('returnToLobby',()=>{const room=rooms.get(socket.data.room);if(!room?.game?.finished||!room.ids.includes(socket.id))return;room.game=null;room.private=true;room.hostId=room.hostId||room.ids[0];room.ready=room.ids.map(()=>false);room.rematchReady=room.ids.map(()=>false);io.to(socket.data.room).emit('returnedToLobby');lobbyUpdate(socket.data.room,room)});
 socket.on('rematchReady',ready=>{const room=rooms.get(socket.data.room);if(!room?.game?.finished||room.ids.length!==2||typeof ready!=='boolean')return;const index=room.ids.indexOf(socket.id);if(index<0)return;room.rematchReady[index]=ready;room.ids.forEach((id,i)=>io.to(id).emit('rematchUpdate',{you:room.rematchReady[i],opponent:room.rematchReady[1-i]}));if(room.rematchReady.every(Boolean))startMatch(socket.data.room,room)});
 socket.on('input', input => {
   const room = rooms.get(socket.data.room);
   if (!room?.game || room.game.finished) return;
   const i = room.ids.indexOf(socket.id);
   if (i < 0) return;
   if (room.streams[i]) {
     room.streams[i].push(input);
     return;
   }
   // Browsers still running the earlier client send held controls as an object.
   const seq = Number(input?.seq) || 0;
   if (seq < room.lastInputSeq[i]) return;
   room.lastInputSeq[i] = seq;
   if (input?.swing && !room.inputs[i].swing) room.pendingSwing[i] = true;
   room.inputs[i] = {up:!!input?.up, down:!!input?.down, left:!!input?.left,
     right:!!input?.right, swing:!!input?.swing, slow:!!input?.slow, sprint:!!input?.sprint,
     moveBoost: Math.max(0, Math.min(1, Number(input?.moveBoost) || 0))};
 });
 socket.on('leaveRoom',()=>leave(socket));socket.on('disconnect',()=>leave(socket));
});
function stepRoom(room) {
  if (!room.game || room.game.finished || room.ids.length !== 2) return;
  const phase = room.game.phase;
  const inputs = room.streams.map((stream, i) => stream ? stream.next() :
    (room.pendingSwing[i] ? {...room.inputs[i], swing:true} : room.inputs[i]));
  room.pendingSwing.fill(false);
  engine.step(room.game, inputs);
  room.dirty = true;
  if (room.game.event) room.events.push(room.game.event);
  if (phase !== room.game.phase || room.game.event) room.reliable = true;
}

function broadcastRoom(room) {
  if (!room.game || !room.dirty) return;
  let packed, legacy;
  room.ids.forEach((id, i) => {
    const target = io.to(id);
    const channel = (room.reliable ? target : target.volatile).compress(false);
    if (room.streams[i]) {
      packed ??= netcode.packState(room.game, room.events);
      channel.emit('state', [...packed, room.streams[i].ack]);
    } else {
      legacy ??= publicState(room.game);
      channel.emit('state', {...legacy, ack:room.lastInputSeq[i], event:room.events.at(-1)});
    }
  });
  room.dirty = room.reliable = false;
  room.events = [];
}

// Advance physics on fixed ticks. Coalesce catch-up ticks and retain scoring
// and hit events until the next broadcast, including the final match result.
let previousTick = performance.now(), accumulator = 0, lastBroadcast = -Infinity;
setInterval(() => {
  const now = performance.now();
  accumulator += Math.min(now - previousTick, 100);
  previousTick = now;
  while (accumulator >= netcode.stepMs) {
    rooms.forEach(stepRoom);
    accumulator -= netcode.stepMs;
  }
  if (now - lastBroadcast >= netcode.statePacketMs) {
    rooms.forEach(broadcastRoom);
    lastBroadcast = now;
  }
}, 8);
const PORT=process.env.PORT||3000;
// Bind on every interface so other devices on the same LAN can connect.
server.listen(PORT,'0.0.0.0',()=>console.log(`Mini Pickleball running on http://localhost:${PORT}`));
