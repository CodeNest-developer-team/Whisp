const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Simple request logger for debugging
app.use((req, res, next)=>{
  if(req.url.startsWith('/api')){
    console.log(new Date().toISOString(), req.method, req.url);
  }
  next();
});

function loadDb(){
  try{
    if(!fs.existsSync(DB_PATH)){
      const init = { users: [], servers: [], timeline: [], dms: [] };
      fs.writeFileSync(DB_PATH, JSON.stringify(init, null, 2));
    }
    const raw = fs.readFileSync(DB_PATH);
    return JSON.parse(raw);
  }catch(e){
    console.error('DB load error', e);
    return { users: [], servers: [], timeline: [], dms: [] };
  }
}

function saveDb(db){
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

// REST APIs
app.get('/api/timeline', (req, res)=>{
  const db = loadDb();
  res.json(db.timeline || []);
});

app.post('/api/timeline', (req, res)=>{
  const { author = 'Anonymous', text = '' } = req.body;
  const db = loadDb();
  const post = { id: Date.now(), author, text, createdAt: new Date().toISOString() };
  db.timeline.unshift(post);
  saveDb(db);
  io.emit('timeline:new', post);
  res.json(post);
});

app.get('/api/servers', (req, res)=>{
  const db = loadDb();
  res.json(db.servers || []);
});

app.post('/api/servers', (req, res)=>{
  const { name = 'New Server' } = req.body;
  const db = loadDb();
  const srv = { id: Date.now().toString(), name, channels: [ { id: 'general', name: 'general' } ], messages: [] };
  db.servers.push(srv);
  saveDb(db);
  io.emit('server:new', srv);
  res.json(srv);
});

// Get server by id (including messages)
app.get('/api/servers/:id', (req, res)=>{
  const db = loadDb();
  console.log('GET /api/servers/:id', req.params.id, 'known ids=', (db.servers||[]).map(s=>s.id));
  const srv = db.servers.find(s=>s.id===req.params.id);
  if(!srv){
    console.log('server not found for id', req.params.id);
    return res.status(404).json({ error: 'not found' });
  }
  res.json(srv);
});

// Post a message to a server (persist and broadcast)
app.post('/api/servers/:id/messages', (req, res)=>{
  const { text = '', channelId = 'general' } = req.body;
  const db = loadDb();
  const srv = db.servers.find(s=>s.id===req.params.id);
  if(!srv) return res.status(404).json({ error: 'server not found' });
  const msg = { id: Date.now(), author: 'anonymous', text, channelId, createdAt: new Date().toISOString() };
  srv.messages = srv.messages || [];
  srv.messages.push(msg);
  saveDb(db);
  io.to(`server:${srv.id}`).emit('server:message', { serverId: srv.id, msg });
  res.json(msg);
});

app.get('/api/dms', (req, res)=>{
  const db = loadDb();
  res.json(db.dms || []);
});

// Get DM thread by id
app.get('/api/dms/:id', (req, res)=>{
  const db = loadDb();
  const thread = db.dms.find(d=>d.id===req.params.id);
  if(!thread) return res.status(404).json({ error: 'dm thread not found' });
  res.json(thread);
});

// Users
app.get('/api/users', (req, res)=>{
  const db = loadDb();
  res.json(db.users || []);
});

app.post('/api/users', (req, res)=>{
  console.log('POST /api/users body=', req.body);
  const { name } = req.body || {};
  if(!name || !name.toString().trim()){
    console.log('user create failed: name missing');
    return res.status(400).json({ error: 'name required' });
  }
  const db = loadDb();
  const id = Date.now().toString();
  const user = { id, name: name.toString().trim() };
  db.users.push(user);
  saveDb(db);
  console.log('user created', user);
  res.json(user);
});

app.post('/api/dms', (req, res)=>{
  const { from = 'me', to = 'them', text = '' } = req.body;
  const db = loadDb();
  const threadId = [from,to].sort().join('-');
  let thread = db.dms.find(d=>d.id===threadId);
  if(!thread){
    thread = { id: threadId, participants: [from,to], messages: [] };
    db.dms.push(thread);
  }
  const msg = { id: Date.now(), from, text, createdAt: new Date().toISOString() };
  thread.messages.push(msg);
  saveDb(db);
  io.to(threadId).emit('dm:new', { threadId, msg });
  res.json(msg);
});

// Socket.io
io.on('connection', (socket)=>{
  console.log('socket connected:', socket.id);
  socket.on('join:server', (serverId)=>{
    console.log('socket join:server', socket.id, serverId);
    socket.join(`server:${serverId}`);
  });

  socket.on('leave:server', (serverId)=>{
    console.log('socket leave:server', socket.id, serverId);
    socket.leave(`server:${serverId}`);
  });

  socket.on('join:dm', (threadId)=>{
    console.log('socket join:dm', socket.id, threadId);
    socket.join(threadId);
  });

  socket.on('server:message', ({ serverId, channelId='general', author='anon', text='' })=>{
    console.log('socket server:message', { serverId, author, text: String(text).slice(0,80) });
    const db = loadDb();
    const srv = db.servers.find(s=>s.id===serverId);
    const msg = { id: Date.now(), author, text, channelId, createdAt: new Date().toISOString() };
    if(srv){
      srv.messages = srv.messages || [];
      srv.messages.push(msg);
      saveDb(db);
    }
    io.to(`server:${serverId}`).emit('server:message', { serverId, msg });
  });

  // P2P DM via socket.io (no persistence)
  socket.on('dm:send', ({ to, text })=>{
    console.log('socket dm:send', socket.id, 'to', to, 'text:', String(text).slice(0,80));
    const msg = { id: Date.now(), text, createdAt: new Date().toISOString() };
    // emit to recipient (they're in a room named by their user/session id or we can use a global handler)
    io.to(to).emit('dm:receive', { from: socket.id, msg });
  });
});

server.listen(PORT, ()=>{
  console.log(`Server listening on http://localhost:${PORT}`);
});
