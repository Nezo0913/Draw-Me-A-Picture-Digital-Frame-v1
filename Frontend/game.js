import { db, ref, set, get, update, onValue, push, remove, onDisconnect }
from "../backend/firebase.js";

// ========================= CLIENT IDENTITY =========================
let clientId = sessionStorage.getItem('dmClientId');
if (!clientId) { clientId = crypto.randomUUID(); sessionStorage.setItem('dmClientId', clientId); }

// ========================= STATE =========================
let currentRoom     = null;
let currentName     = 'Player';
let currentRound    = 0;
let currentLeader   = null;
let leaderQueue     = [];
let currentPrompt   = '';
let myVote          = null;   // drawerId voted for this voting phase
let voteLocked      = false;
let roundInterval   = null;
let allLines        = {};
let canvasUnsubscribe = null;
let attachedRound   = null;
let isRendering     = false;
let lastGameState   = null;
let playerScores    = {};     // { clientId: score }
let playerNames     = {};     // { clientId: name }

// Drawing tool state
let drawing = false;
let toolMode = 'draw';
let brushColor = '#000000';
let brushSize  = 3;
let lastX = 0, lastY = 0;

const COLORS = ['#000000','#e63946','#2196f3','#4caf50','#ff9800','#9c27b0','#ffffff'];

// ========================= HELPERS =========================
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.getElementById('toast-wrap').appendChild(el);
  setTimeout(() => el.remove(), 3100);
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function avatarColor(str) {
  const palette = ['#e63946','#2196f3','#4caf50','#ff9800','#9c27b0','#ff6b6b','#6be0ff'];
  let h = 0;
  for (let c of str) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return palette[h % palette.length];
}

function playerAvatar(name) {
  const color = avatarColor(name);
  return `<div class="player-avatar" style="background:${color};color:#fff;">${name[0].toUpperCase()}</div>`;
}

function generateRoomCode() {
  return Array.from({length:6}, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random()*36)]).join('');
}

// ========================= NAME PROMPT =========================
function getPlayerName() {
  const v = document.getElementById('input-name').value.trim();
  return v || `Player-${Math.floor(Math.random()*9000)+1000}`;
}

// ========================= CREATE ROOM =========================
window.createRoom = async function() {
  currentName = getPlayerName();
  const code  = generateRoomCode();
  currentRoom = code;

  await set(ref(db, `rooms/${code}`), {
    gameState: 'LOBBY',
    host: clientId,
    players: {},
    scores: {}
  });

  const pRef = ref(db, `rooms/${code}/players/${clientId}`);
  await set(pRef, { name: currentName });
  onDisconnect(pRef).remove();

  enterRoom(code);
};

// ========================= JOIN ROOM =========================
window.joinRoom = async function() {
  currentName = getPlayerName();
  const code  = document.getElementById('input-code').value.trim().toUpperCase();
  if (!code) { toast('Enter a room code'); return; }

  const snap = await get(ref(db, `rooms/${code}`));
  if (!snap.exists()) { toast('Room not found'); return; }

  const data    = snap.val();
  const players = data.players || {};

  if (Object.keys(players).length >= 7) { toast('Room is full (7 max)'); return; }
  if (data.gameState !== 'LOBBY') { toast('Game already in progress'); return; }

  const pRef = ref(db, `rooms/${code}/players/${clientId}`);
  await set(pRef, { name: currentName });
  onDisconnect(pRef).remove();

  enterRoom(code);
};

// ========================= ENTER ROOM =========================
function enterRoom(code) {
  currentRoom = code;
  document.getElementById('room-code-display').textContent = code;
  showScreen('screen-lobby');
  syncLobby(code);
  syncGameState(code);
}

// ========================= SYNC LOBBY =========================
function syncLobby(code) {
  let prev = {};

  onValue(ref(db, `rooms/${code}/players`), snap => {
    const players = snap.val() || {};
    playerNames   = {};
    Object.entries(players).forEach(([id, p]) => { playerNames[id] = p.name; });

    const ids = Object.keys(players);
    const count = ids.length;

    document.getElementById('lobby-count').textContent = `${count} / 7`;

    // Detect leavers
    for (const id in prev) {
      if (!players[id]) {
        document.getElementById('lobby-notice').textContent = `${prev[id].name} left the lobby`;
        setTimeout(() => { document.getElementById('lobby-notice').textContent = ''; }, 3000);
      }
    }
    prev = players;

    // Render player list
    const list = document.getElementById('lobby-player-list');
    list.innerHTML = '';
    ids.forEach(id => {
      const div = document.createElement('div');
      div.className = 'player-item' + (id === clientId ? ' is-me' : '');
      div.innerHTML = `${playerAvatar(players[id].name)}<span class="player-name">${players[id].name}${id===clientId?' <span style="font-size:11px;color:var(--muted);">(you)</span>':''}</span>`;
      list.appendChild(div);
    });

    // Host controls
    get(ref(db, `rooms/${code}/host`)).then(hs => {
      const isHost = hs.val() === clientId;
      document.getElementById('lobby-host-controls').style.display = isHost ? 'block' : 'none';
      document.getElementById('lobby-wait-msg').style.display      = isHost ? 'none' : 'block';
      const btn = document.getElementById('btn-start');
      if (count >= 4) { btn.disabled = false; btn.textContent = `Start Game (${count} players)`; }
      else            { btn.disabled = true;  btn.textContent = `Start Game (need ${4-count} more)`; }
    });

    document.getElementById('lobby-status').innerHTML = count >= 4
      ? `Ready to start!`
      : `Waiting for ${4-count} more player${4-count!==1?'s':''}<span class="waiting-dots"></span>`;
  });
}

// ========================= START GAME =========================
window.startGame = async function() {
  if (!currentRoom) return;
  const snap = await get(ref(db, `rooms/${currentRoom}/players`));
  const ids  = Object.keys(snap.val() || {});
  if (ids.length < 4) { toast('Need at least 4 players'); return; }

  // Shuffle leader queue — every player becomes leader once
  const queue = [...ids].sort(() => Math.random() - 0.5);

  // Init scores
  const scores = {};
  ids.forEach(id => { scores[id] = 0; });

  await set(ref(db, `rooms/${currentRoom}/leaderQueue`),  queue);
  await set(ref(db, `rooms/${currentRoom}/currentRound`), 0);
  await set(ref(db, `rooms/${currentRoom}/currentLeader`),queue[0]);
  await set(ref(db, `rooms/${currentRoom}/scores`),       scores);
  await set(ref(db, `rooms/${currentRoom}/votes`),        null);
  await set(ref(db, `rooms/${currentRoom}/gameState`),    'PROMPT');
};

// ========================= SYNC GAME STATE =========================
function syncGameState(code) {
  onValue(ref(db, `rooms/${code}/leaderQueue`),   s => { leaderQueue   = s.val() || []; });
  onValue(ref(db, `rooms/${code}/currentRound`),  s => { currentRound  = s.val() ?? 0; });
  onValue(ref(db, `rooms/${code}/currentLeader`), s => { currentLeader = s.val(); });
  onValue(ref(db, `rooms/${code}/prompt`),        s => { currentPrompt = s.val() || ''; });
  onValue(ref(db, `rooms/${code}/scores`),        s => { playerScores  = s.val() || {}; renderSidebarScores(); });
  onValue(ref(db, `rooms/${code}/players`),       s => { Object.entries(s.val()||{}).forEach(([id,p]) => { playerNames[id] = p.name; }); });

  // Round timer display
  onValue(ref(db, `rooms/${code}/roundTime`), s => {
    const t = s.val();
    if (t == null) return;
    updateTimerRing('draw', t, 30);
  });
  // Vote timer display
  onValue(ref(db, `rooms/${code}/voteTime`), s => {
    const t = s.val();
    if (t == null) return;
    updateTimerRing('vote', t, 20);
  });

  onValue(ref(db, `rooms/${code}/gameState`), s => {
    const state = s.val();
    if (!state || state === lastGameState) return;
    lastGameState = state;
    requestAnimationFrame(() => renderGameState(state));
  });
}

function updateTimerRing(which, t, total) {
  const circ = which === 'draw' ? 138.2 : 213.6;
  const frac = Math.max(0, t / total);
  const offset = circ * (1 - frac);
  const fg  = document.getElementById(`timer-fg-${which}`);
  const num = document.getElementById(`timer-${which}-num`);
  if (fg)  { fg.style.strokeDashoffset = offset; fg.classList.toggle('urgent', t <= 5); }
  if (num) num.textContent = t;
}

// ========================= RENDER GAME STATE =========================
function renderGameState(state) {
  // Reset per-state vars
  myVote     = null;
  voteLocked = false;

  if (state === 'LOBBY') {
    stopRoundTimer();
    detachCanvas();
    showScreen('screen-lobby');
  }

  if (state === 'PROMPT') {
    stopRoundTimer();
    detachCanvas();
    renderPromptScreen();
    showScreen('screen-prompt');
  }

  if (state === 'DRAWING') {
    renderDrawingScreen();
    showScreen('screen-drawing');
    if (clientId === currentLeader) {
      startRoundTimer(30, 'roundTime', async () => {
        await set(ref(db, `rooms/${currentRoom}/gameState`), 'VOTING');
      });
    }
  }

  if (state === 'VOTING') {
    stopRoundTimer();
    detachCanvas();
    renderVotingScreen();
    showScreen('screen-voting');
    if (clientId === currentLeader) {
      startRoundTimer(20, 'voteTime', async () => {
        await resolveVotes();
      });
    }
  }

  if (state === 'TIEBREAK') {
    renderTiebreakScreen();
    showScreen('screen-tiebreak');
  }

  if (state === 'REVEAL') {
    stopRoundTimer();
    renderRevealScreen();
    showScreen('screen-reveal');
  }

  if (state === 'FINAL') {
    renderFinalScreen();
    showScreen('screen-final');
  }
}

// ========================= PROMPT SCREEN =========================
function renderPromptScreen() {
  const roundNum  = currentRound + 1;
  const totalRnds = leaderQueue.length;
  document.getElementById('prompt-round-badge').textContent = `Round ${roundNum} of ${totalRnds}`;

  const isLeader = clientId === currentLeader;
  document.getElementById('prompt-leader-ui').style.display  = isLeader ? 'block' : 'none';
  document.getElementById('prompt-wait-ui').style.display    = isLeader ? 'none'  : 'block';
  document.getElementById('prompt-title').textContent        = isLeader ? "Your turn to lead!" : "Leader is choosing…";
  document.getElementById('prompt-sub').textContent          = isLeader
    ? "Enter a drawing prompt for everyone."
    : "Sit tight while the leader picks a prompt.";

  if (!isLeader && playerNames[currentLeader]) {
    document.getElementById('prompt-leader-name').textContent = `Leader: ${playerNames[currentLeader]}`;
  }
  document.getElementById('input-prompt').value = '';
}

window.submitPrompt = async function() {
  if (clientId !== currentLeader) return;
  const prompt = document.getElementById('input-prompt').value.trim();
  if (!prompt) { toast('Enter a prompt first'); return; }
  await set(ref(db, `rooms/${currentRoom}/prompt`),    prompt);
  await set(ref(db, `rooms/${currentRoom}/gameState`), 'DRAWING');
};

// ========================= DRAWING SCREEN =========================
function renderDrawingScreen() {
  document.getElementById('draw-prompt-text').textContent = currentPrompt;
  document.getElementById('draw-round-label').textContent = `Round ${currentRound+1} / ${leaderQueue.length}`;

  const isLeader = clientId === currentLeader;

  // Leader sees overlay message, not canvas
  const canvasEl  = document.getElementById('game-canvas');
  const toolbar   = document.getElementById('draw-toolbar');
  const leaderMsg = document.getElementById('leader-drawing-msg');

  canvasEl.style.display  = isLeader ? 'none' : 'block';
  toolbar.style.display   = isLeader ? 'none' : 'flex';
  leaderMsg.style.display = isLeader ? 'flex' : 'none';

  if (!isLeader) {
    if (attachedRound !== currentRound) {
      detachCanvas();
      attachCanvas(currentRoom, currentRound);
      attachedRound = currentRound;
    }
  }

  renderSidebarScores();
  renderSidebarPlayers();
  buildColorSwatches();
}

function buildColorSwatches() {
  const wrap = document.getElementById('color-swatches');
  wrap.innerHTML = '';
  COLORS.forEach(c => {
    const el = document.createElement('div');
    el.className = 'color-swatch' + (c === brushColor ? ' active' : '');
    el.style.background = c;
    el.style.border = c === '#ffffff' ? '2px solid var(--border)' : '2px solid transparent';
    el.onclick = () => {
      brushColor = c;
      toolMode = 'draw';
      document.getElementById('tool-draw').classList.add('active');
      document.getElementById('tool-erase').classList.remove('active');
      document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      el.classList.add('active');
    };
    wrap.appendChild(el);
  });
}

function renderSidebarPlayers() {
  const list = document.getElementById('draw-player-list');
  list.innerHTML = '';
  Object.entries(playerNames).forEach(([id, name]) => {
    const div = document.createElement('div');
    div.className = 'player-item' + (id === currentLeader ? ' is-leader' : '') + (id === clientId ? ' is-me' : '');
    div.innerHTML = `${playerAvatar(name)}<span class="player-name" style="font-size:13px;">${name}${id===currentLeader?' 👑':''}</span>`;
    list.appendChild(div);
  });
}

function renderSidebarScores() {
  const wrap = document.getElementById('draw-scoreboard');
  if (!wrap) return;
  const sorted = Object.entries(playerScores).sort((a,b) => b[1]-a[1]);
  wrap.innerHTML = sorted.map(([id, pts]) =>
    `<div class="player-item"><span style="font-size:13px;">${playerNames[id]||'?'}</span><span style="margin-left:auto;font-family:var(--font-head);font-weight:700;color:var(--accent);">${pts}</span></div>`
  ).join('');
}

// ========================= CANVAS =========================
const canvas = document.getElementById('game-canvas');
const ctx    = canvas.getContext('2d');

function attachCanvas(roomId, round) {
  allLines = {};
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const linesRef = ref(db, `rooms/${roomId}/rounds/${round}/lines`);
  canvasUnsubscribe = onValue(linesRef, snap => {
    allLines = snap.val() || {};
    redrawCanvas();
  });
}

function detachCanvas() {
  if (canvasUnsubscribe) { canvasUnsubscribe(); canvasUnsubscribe = null; }
  attachedRound = null;
  allLines = {};
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function redrawCanvas() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  for (const key in allLines) renderLine(allLines[key]);
}

function renderLine(l) {
  ctx.beginPath();
  ctx.moveTo(l.x1, l.y1);
  ctx.lineTo(l.x2, l.y2);
  ctx.lineWidth  = l.size  || (l.mode === 'draw' ? 3 : 20);
  ctx.lineCap    = 'round';
  ctx.strokeStyle = l.mode === 'erase' ? '#ffffff' : (l.color || '#000000');
  ctx.stroke();
}

function getXY(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  if (e.touches) {
    return [(e.touches[0].clientX - rect.left) * scaleX, (e.touches[0].clientY - rect.top) * scaleY];
  }
  return [(e.clientX - rect.left) * scaleX, (e.clientY - rect.top) * scaleY];
}

canvas.addEventListener('mousedown',  e => { drawing=true; [lastX,lastY]=getXY(e); });
canvas.addEventListener('mouseup',    () => drawing=false);
canvas.addEventListener('mouseleave', () => drawing=false);
canvas.addEventListener('mousemove',  e => { if (!drawing) return; doDraw(e); });

canvas.addEventListener('touchstart',  e => { e.preventDefault(); drawing=true; [lastX,lastY]=getXY(e); }, {passive:false});
canvas.addEventListener('touchend',    e => { e.preventDefault(); drawing=false; }, {passive:false});
canvas.addEventListener('touchmove',   e => { e.preventDefault(); if (!drawing) return; doDraw(e); }, {passive:false});

function doDraw(e) {
  if (clientId === currentLeader) return; // leader can't draw
  const [x, y] = getXY(e);
  const lineData = { x1:lastX, y1:lastY, x2:x, y2:y, mode:toolMode, color:brushColor, size:toolMode==='erase'?20:brushSize, clientId };
  renderLine(lineData);
  push(ref(db, `rooms/${currentRoom}/rounds/${currentRound}/lines`), lineData);
  [lastX, lastY] = [x, y];
}

window.setTool = function(t) {
  toolMode = t;
  document.getElementById('tool-draw').classList.toggle('active',  t === 'draw');
  document.getElementById('tool-erase').classList.toggle('active', t === 'erase');
};

document.getElementById('brush-size').addEventListener('input', e => { brushSize = parseInt(e.target.value); });

window.clearMyDrawing = async function() {
  const toDelete = [];
  for (const key in allLines) {
    if (allLines[key].clientId === clientId) toDelete.push(key);
  }
  await Promise.all(toDelete.map(k => remove(ref(db, `rooms/${currentRoom}/rounds/${currentRound}/lines/${k}`))));
};

// ========================= VOTING SCREEN =========================
async function renderVotingScreen() {
  const grid = document.getElementById('vote-grid');
  grid.innerHTML = '';
  document.getElementById('vote-prompt-label').textContent = `Prompt: "${currentPrompt}"`;
  document.getElementById('vote-status-msg').textContent   = 'Select a drawing, then lock your vote.';
  document.getElementById('btn-lock-vote').disabled        = true;
  myVote = null; voteLocked = false;

  // Get all drawings for this round
  // Each non-leader player has a drawing: their clientId
  const nonLeaders = leaderQueue.filter((_,i) => leaderQueue[i] !== currentLeader
    ? true : false); // Everyone except current leader drew

  // Actually: all players except current leader drew this round
  const allPlayerIds = Object.keys(playerNames);
  const drawers = allPlayerIds.filter(id => id !== currentLeader);

  for (const drawerId of drawers) {
    const card = document.createElement('div');
    const isOwn = drawerId === clientId;
    card.className = 'vote-card' + (isOwn ? ' own' : '');
    card.dataset.drawer = drawerId;

    const wrap = document.createElement('div');
    wrap.className = 'vote-canvas-wrap';
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    wrap.appendChild(c);

    const footer = document.createElement('div');
    footer.className = 'vote-footer';
    footer.innerHTML = `<span class="vote-anon">${isOwn ? 'Your drawing' : 'Anonymous'}</span>
      ${isOwn ? '<span class="own-label">YOURS</span>' : '<div class="vote-check">✓</div>'}`;

    card.appendChild(wrap);
    card.appendChild(footer);

    if (!isOwn) {
      card.onclick = () => selectVote(drawerId);
    }

    grid.appendChild(card);
    loadMiniCanvas(drawerId, c);
  }
}

function selectVote(drawerId) {
  if (voteLocked) return;
  myVote = drawerId;
  document.querySelectorAll('.vote-card').forEach(c => c.classList.remove('selected'));
  const target = document.querySelector(`.vote-card[data-drawer="${drawerId}"]`);
  if (target) target.classList.add('selected');
  document.getElementById('btn-lock-vote').disabled = false;
}

window.lockVote = async function() {
  if (!myVote || voteLocked) return;
  voteLocked = true;
  document.getElementById('btn-lock-vote').disabled = true;
  document.getElementById('vote-status-msg').textContent = 'Vote locked in! ✓';

  // Save vote to Firebase: rooms/code/roundVotes/round/clientId = drawerId
  await set(ref(db, `rooms/${currentRoom}/roundVotes/${currentRound}/${clientId}`), myVote);
  toast('Vote locked!');
};

// Leader's auto-resolve after timer
async function resolveVotes() {
  if (clientId !== currentLeader) return;

  const snap = await get(ref(db, `rooms/${currentRoom}/roundVotes/${currentRound}`));
  const votes = snap.val() || {};

  // Tally
  const tally = {}; // drawerId → count
  Object.values(votes).forEach(drawerId => {
    tally[drawerId] = (tally[drawerId] || 0) + 1;
  });

  // Anyone who didn't vote loses 1pt
  const allIds = Object.keys(playerNames);
  const nonLeaderIds = allIds.filter(id => id !== currentLeader);
  
  // Apply -1 for non-voters
  for (const id of allIds) {
    if (!votes[id] && id !== currentLeader) {
      // didn't vote in time
      playerScores[id] = (playerScores[id] || 0) - 1;
    }
  }

  const maxVotes = Math.max(...Object.values(tally), 0);
  const winners  = Object.keys(tally).filter(id => tally[id] === maxVotes);

  await set(ref(db, `rooms/${currentRoom}/roundTally`), tally);
  await set(ref(db, `rooms/${currentRoom}/scores`),     playerScores);

  if (winners.length > 1) {
    // Tiebreak needed — store tied candidates
    await set(ref(db, `rooms/${currentRoom}/tiedCandidates`), winners);
    await set(ref(db, `rooms/${currentRoom}/gameState`),       'TIEBREAK');
  } else {
    // Declare winner
    const winnerId = winners[0];
    if (winnerId) await applyRoundScores(tally, winnerId);
    await set(ref(db, `rooms/${currentRoom}/roundWinner`), winnerId || null);
    await set(ref(db, `rooms/${currentRoom}/gameState`),   'REVEAL');
  }
}

async function applyRoundScores(tally, winnerId) {
  // +3 for most votes, +1 for at least one vote
  const newScores = { ...playerScores };
  for (const [id, cnt] of Object.entries(tally)) {
    newScores[id] = (newScores[id] || 0) + (cnt > 0 ? 1 : 0);
    if (id === winnerId) newScores[id] += 2; // total +3 (already got +1)
  }
  playerScores = newScores;
  await set(ref(db, `rooms/${currentRoom}/scores`), newScores);
}

function loadMiniCanvas(drawerId, canvasEl) {
  const ctx2 = canvasEl.getContext('2d');
  get(ref(db, `rooms/${currentRoom}/rounds/${currentRound}/lines`)).then(snap => {
    const lines = snap.val() || {};
    ctx2.clearRect(0, 0, canvasEl.width, canvasEl.height);
    for (const key in lines) {
      const l = lines[key];
      if (l.clientId !== drawerId) continue;
      ctx2.beginPath();
      ctx2.moveTo(l.x1 * (canvasEl.width/800), l.y1 * (canvasEl.height/520));
      ctx2.lineTo(l.x2 * (canvasEl.width/800), l.y2 * (canvasEl.height/520));
      ctx2.lineWidth   = Math.max(1, (l.size||3) * (canvasEl.width/800));
      ctx2.lineCap     = 'round';
      ctx2.strokeStyle = l.mode === 'erase' ? '#ffffff' : (l.color || '#000000');
      ctx2.stroke();
    }
  });
}

// ========================= TIEBREAK =========================
async function renderTiebreakScreen() {
  const snap = await get(ref(db, `rooms/${currentRoom}/tiedCandidates`));
  const tied  = snap.val() || [];
  const isLeader = clientId === currentLeader;

  document.getElementById('tiebreak-wait').style.display   = isLeader ? 'none'  : 'block';
  document.getElementById('tiebreak-grid').style.display   = isLeader ? 'grid'  : 'none';
  document.getElementById('tiebreak-title').textContent    = isLeader ? "Break the tie!" : "Leader is deciding…";
  document.getElementById('tiebreak-sub').textContent      = isLeader
    ? `It's tied! Choose the winner between ${tied.length} drawings.`
    : `The leader has final say on tied drawings.`;

  if (!isLeader) return;

  const grid = document.getElementById('tiebreak-grid');
  grid.innerHTML = '';
  for (const drawerId of tied) {
    const card = document.createElement('div');
    card.className = 'tiebreak-card';

    const wrap = document.createElement('div');
    wrap.className = 'reveal-canvas-wrap';
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    wrap.appendChild(c);

    const footer = document.createElement('div');
    footer.className = 'reveal-footer';
    footer.innerHTML = `<span class="reveal-name">${playerNames[drawerId] || '?'}</span>
      <button class="btn btn-primary btn-sm" style="width:auto;">Pick Winner</button>`;
    footer.querySelector('button').onclick = () => leaderPickWinner(drawerId);

    card.appendChild(wrap);
    card.appendChild(footer);
    grid.appendChild(card);
    loadMiniCanvas(drawerId, c);
  }
}

window.leaderPickWinner = async function(drawerId) {
  if (clientId !== currentLeader) return;
  const snap = await get(ref(db, `rooms/${currentRoom}/roundTally`));
  const tally = snap.val() || {};
  await applyRoundScores(tally, drawerId);
  await set(ref(db, `rooms/${currentRoom}/roundWinner`), drawerId);
  await set(ref(db, `rooms/${currentRoom}/gameState`),   'REVEAL');
};

// ========================= REVEAL =========================
async function renderRevealScreen() {
  const [tallySnap, winnerSnap] = await Promise.all([
    get(ref(db, `rooms/${currentRoom}/roundTally`)),
    get(ref(db, `rooms/${currentRoom}/roundWinner`))
  ]);
  const tally    = tallySnap.val()  || {};
  const winnerId = winnerSnap.val();

  document.getElementById('reveal-prompt-label').textContent = `Prompt: "${currentPrompt}"`;
  document.getElementById('reveal-title').textContent        = winnerId
    ? `${playerNames[winnerId] || '?'} wins this round! 🎉`
    : "No winner this round.";

  const grid = document.getElementById('reveal-grid');
  grid.innerHTML = '';

  const allIds = Object.keys(playerNames).filter(id => id !== currentLeader);
  // Sort by votes desc
  allIds.sort((a,b) => (tally[b]||0) - (tally[a]||0));

  for (const drawerId of allIds) {
    const votes    = tally[drawerId] || 0;
    const isWinner = drawerId === winnerId;

    const card = document.createElement('div');
    card.className = 'reveal-card' + (isWinner ? ' winner' : '');

    const wrap = document.createElement('div');
    wrap.className = 'reveal-canvas-wrap';
    const c = document.createElement('canvas');
    c.width = 400; c.height = 300;
    wrap.appendChild(c);

    const footer = document.createElement('div');
    footer.className = 'reveal-footer';
    footer.innerHTML = `
      ${isWinner ? '<span class="winner-crown">👑</span>' : ''}
      <span class="reveal-name">${playerNames[drawerId] || '?'}</span>
      <span class="vote-count">${votes} vote${votes!==1?'s':''}</span>`;

    card.appendChild(wrap);
    card.appendChild(footer);
    grid.appendChild(card);
    loadMiniCanvas(drawerId, c);
  }

  // Score changes
  const scoreWrap = document.getElementById('round-score-changes');
  const sorted = Object.entries(playerScores).sort((a,b) => b[1]-a[1]);
  scoreWrap.innerHTML = `<div class="sidebar-label" style="margin-bottom:8px;">Scoreboard</div>` +
    sorted.map(([id,pts], i) => {
      const rankClass = i===0?'gold':i===1?'silver':i===2?'bronze':'';
      return `<div class="scoreboard-row">
        <div class="rank ${rankClass}">${i+1}</div>
        ${playerAvatar(playerNames[id]||'?')}
        <div class="sb-name">${playerNames[id]||'?'}</div>
        <div class="sb-pts">${pts}</div>
      </div>`;
    }).join('');

  // Next round / end
  const nextRound = currentRound + 1;
  const isLast    = nextRound >= leaderQueue.length;
  const nextInfo  = document.getElementById('reveal-next-info');
  const nextBtn   = document.getElementById('btn-next-round');

  nextInfo.textContent = isLast ? "This was the last round!" : `Next up: Round ${nextRound+1} of ${leaderQueue.length}`;

  // Only leader advances the round
  nextBtn.style.display = clientId === currentLeader ? 'inline-flex' : 'none';
  nextBtn.textContent   = isLast ? "See Final Results" : "Next Round →";
}

window.advanceNextRound = async function() {
  if (clientId !== currentLeader) return;
  const next = currentRound + 1;

  if (next >= leaderQueue.length) {
    await set(ref(db, `rooms/${currentRoom}/gameState`), 'FINAL');
    return;
  }

  await set(ref(db, `rooms/${currentRoom}/currentRound`),  next);
  await set(ref(db, `rooms/${currentRoom}/currentLeader`), leaderQueue[next]);
  await set(ref(db, `rooms/${currentRoom}/roundTally`),    null);
  await set(ref(db, `rooms/${currentRoom}/roundWinner`),   null);
  await set(ref(db, `rooms/${currentRoom}/tiedCandidates`),null);
  await set(ref(db, `rooms/${currentRoom}/prompt`),        '');
  await set(ref(db, `rooms/${currentRoom}/gameState`),     'PROMPT');
};

// ========================= FINAL SCREEN =========================
function renderFinalScreen() {
  const sorted = Object.entries(playerScores).sort((a,b) => b[1]-a[1]);
  document.getElementById('final-scoreboard').innerHTML =
    sorted.map(([id,pts], i) => {
      const rankClass = i===0?'gold':i===1?'silver':i===2?'bronze':'';
      const medals    = ['🥇','🥈','🥉'];
      return `<div class="scoreboard-row">
        <div class="rank ${rankClass}">${medals[i] || (i+1)}</div>
        ${playerAvatar(playerNames[id]||'?')}
        <div class="sb-name" style="font-size:16px;">${playerNames[id]||'?'}</div>
        <div class="sb-pts" style="font-size:26px;">${pts}</div>
      </div>`;
    }).join('');
}

// ========================= TIMERS =========================
function startRoundTimer(seconds, field, onDone) {
  stopRoundTimer();
  let remaining = seconds;
  set(ref(db, `rooms/${currentRoom}/${field}`), remaining);

  roundInterval = setInterval(async () => {
    remaining--;
    await set(ref(db, `rooms/${currentRoom}/${field}`), remaining);
    if (remaining <= 0) {
      stopRoundTimer();
      await onDone();
    }
  }, 1000);
}

function stopRoundTimer() {
  if (roundInterval) { clearInterval(roundInterval); roundInterval = null; }
}

// ========================= RETURN TO LOBBY =========================
window.returnToLobby = async function() {
  if (!currentRoom) return;
  await set(ref(db, `rooms/${currentRoom}/gameState`), 'LOBBY');
};

// ========================= LEAVE ROOM =========================
window.leaveRoom = async function() {
  if (!currentRoom) return;
  await remove(ref(db, `rooms/${currentRoom}/players/${clientId}`));
  currentRoom = null;
  playerNames = {}; playerScores = {};
  showScreen('screen-landing');
};

// ========================= INIT COLOR SWATCHES =========================
buildColorSwatches();
