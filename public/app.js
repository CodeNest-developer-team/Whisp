console.log('app.js loaded');
const socket = io();

// State
let currentServerId = null;
let currentThreadId = null;

// simple UI status for quick info
function debugLog(msg){
  console.log(msg);
  const el = document.getElementById('debug-status');
  if(el) el.textContent = msg;
}

function escapeHtml(s){ return (s||'').toString().replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;" })[c]); }

async function fetchTimeline(){
  debugLog('fetchTimeline called');
  const res = await fetch('/api/timeline');
  const data = await res.json();
  const ul = document.getElementById('posts');
  ul.innerHTML = '';
  data.forEach(p=>{
    const li = document.createElement('li'); li.className='post';
    li.innerHTML = `<strong>${escapeHtml(p.author)}</strong> <small>${new Date(p.createdAt).toLocaleString()}</small><div>${escapeHtml(p.text)}</div>`;
    ul.appendChild(li);
  });
}

// User management
function getCurrentUser(){
  try{ return JSON.parse(localStorage.getItem('me')); }catch(e){ return null; }
}
function setCurrentUser(user){
  localStorage.setItem('me', JSON.stringify(user));
  const el = document.getElementById('current-username');
  if(el) el.textContent = user.name;
  const authorInput = document.getElementById('post-author');
  if(authorInput) authorInput.value = user.name;
}

document.getElementById('post-form').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const author = document.getElementById('post-author').value || (getCurrentUser() && getCurrentUser().name) || 'Anonymous';
  const text = document.getElementById('post-text').value || '';
  await fetch('/api/timeline',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({author,text})});
  document.getElementById('post-text').value='';
});

socket.on('timeline:new', (post)=>{
  debugLog('received timeline:new');
  fetchTimeline();
});

// Servers
const serversMap = new Map();
async function loadServers(){
  debugLog('loadServers()');
  const res = await fetch('/api/servers');
  const data = await res.json();
  console.log('loadServers result', data);
  const el = document.getElementById('servers'); el.innerHTML='';
  data.forEach(s=>{
    serversMap.set(s.id, s);
    const d = document.createElement('div');
    d.className='server-item'; d.style.cursor='pointer';
    d.dataset.id = s.id;
    d.onclick = ()=>{ joinServer(s.id); };
    const title = document.createElement('div'); title.textContent = s.name; title.style.fontWeight='600';
    const meta = document.createElement('div'); meta.style.fontSize='12px'; meta.style.color='#3b5ea8';
    const lastMsg = (s.messages && s.messages.length) ? s.messages[s.messages.length-1] : null;
    meta.textContent = lastMsg ? `last: ${new Date(lastMsg.createdAt).toLocaleTimeString()}` : '';
    d.appendChild(title);
    if(lastMsg) d.appendChild(meta);
    el.appendChild(d);
  });
}

document.getElementById('create-server').addEventListener('click', async ()=>{
  const name = prompt('Server name')||'New Server';
  await fetch('/api/servers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name})});
  loadServers();
});

socket.on('server:new', () => loadServers());

async function joinServer(id){
  debugLog(`joinServer ${id}`);
  currentServerId = id;
  currentThreadId = null;
  socket.emit('join:server', id);
  try{
    const srvRes = await fetch(`/api/servers/${id}`);
    if(!srvRes.ok){
      debugLog(`failed to load server ${id} : ${srvRes.status}`);
      document.getElementById('chat-header').textContent = `#server:${id}`;
      document.getElementById('chat-form').style.display='flex';
      return;
    }
    const srv = await srvRes.json();
    document.getElementById('chat-header').textContent = `#${srv.name} (server)`;
    document.getElementById('chat-form').style.display='flex';
    const msgs = document.getElementById('chat-messages'); msgs.innerHTML = '';
    (srv.messages||[]).forEach(m=>{
      const d = document.createElement('div'); d.className='message'; d.textContent = `${m.author}: ${m.text}`;
      msgs.appendChild(d);
    });
    debugLog(`loaded server ${id} with ${ (srv.messages||[]).length } messages`);
  }catch(err){
    console.error('joinServer error', err);
    debugLog(`error loading server ${id}`);
  }
}

document.getElementById('chat-form').addEventListener('submit', async (e)=>{
  e.preventDefault();
  const text = document.getElementById('chat-input').value || '';
  if(!text) return;
  if(currentServerId){
    debugLog(`posting server message to ${currentServerId}`);
    await fetch(`/api/servers/${currentServerId}/messages`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ text }) });
  } else if(currentThreadId){
    // P2P DM via socket.io
    const me = (getCurrentUser() && getCurrentUser().name) || 'me';
    socket.emit('dm:send', { to: currentThreadId, text });
    // show message locally immediately
    const el = document.getElementById('chat-messages');
    const d = document.createElement('div'); d.className='message'; d.textContent = `${me}: ${text}`;
    el.appendChild(d);
  }
  document.getElementById('chat-input').value='';
});

socket.on('server:message', ({ serverId, msg })=>{
  console.log('socket server:message', serverId, msg);
  if(serverId !== currentServerId) return;
  const el = document.getElementById('chat-messages');
  const d = document.createElement('div'); d.className='message'; d.textContent = `${msg.author}: ${msg.text}`;
  el.appendChild(d);
  debugLog(`recv server message from ${msg.author}`);
});

// DMs
const allUsers = new Map();
async function loadDms(){
  debugLog('loadDms()');
  const res = await fetch('/api/users');
  const users = (await res.json()) || [];
  console.log('loadDms users', users);
  const el = document.getElementById('dms'); el.innerHTML='';
  users.forEach(u=>{
    const d = document.createElement('div'); d.textContent = u.name; d.style.cursor='pointer';
    d.dataset.userId = u.id;
    d.onclick = ()=>{ openDm(u.id, u.name); };
    el.appendChild(d);
  });
}

// Create DM with user selection
document.getElementById('create-dm').addEventListener('click', async ()=>{
  // fetch all users (or use mock list)
  const res = await fetch('/api/users');
  const users = (await res.json()) || [];
  if(!users.length) return alert('ユーザーがいません');
  
  let target = prompt('DM対象を選択: ' + users.map(u=>u.name).join(', '));
  if(!target) return;
  target = target.trim();
  
  // find matching user
  const user = users.find(u => u.name === target);
  if(!user) return alert('ユーザーが見つかりません');
  
  debugLog(`creating DM to ${user.name}`);
  openDm(user.id, user.name);
});

async function openDm(userId, userName){
  debugLog(`openDm ${userId} (${userName})`);
  // switch UI immediately
  currentThreadId = userId;
  currentServerId = null;
  document.getElementById('chat-header').textContent = `DM: ${userName}`;
  document.getElementById('chat-form').style.display='flex';
  const msgs = document.getElementById('chat-messages'); msgs.innerHTML='';
  debugLog(`opened DM with ${userName}`);
}

socket.on('dm:new', ({ threadId, msg })=>{
  console.log('socket dm:new', threadId, msg);
  if(threadId !== currentThreadId) return; // only show if open
  const el = document.getElementById('chat-messages');
  const d = document.createElement('div'); d.className='message'; d.textContent = `${msg.from}: ${msg.text}`;
  el.appendChild(d);
  debugLog(`recv dm from ${msg.from}`);
});

// Init
fetchTimeline();
loadServers();
