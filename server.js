/**
 * Card Games — WebSocket Server
 * Node.js + ws (npm install ws)
 *
 * Chạy: node server.js
 * Deploy: Railway / Render / Fly.io — set PORT env var
 *
 * Hỗ trợ:
 *   - Tiến Lên: phòng 2–4 người, thiếu thì thêm bot
 *   - Xì Dách:  phòng 2 người
 */

const WebSocket = require('ws');
const PORT = process.env.PORT || 8080;

const wss = new WebSocket.Server({ port: PORT });
console.log('Card Games server listening on port', PORT);

/* ============================================================
   UTILITIES
   ============================================================ */
function uid() {
  return Math.random().toString(36).slice(2, 8).toUpperCase().slice(0, 4);
}

function broadcast(room, msg) {
  var json = JSON.stringify(msg);
  room.players.forEach(function (p) {
    if (p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(json);
    }
  });
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/* ============================================================
   CARD ENGINE (server-side shuffle + deal)
   ============================================================ */
function shuffle(arr) {
  var a = arr.slice(), i, j, tmp;
  for (i = a.length - 1; i > 0; i--) {
    j = Math.floor(Math.random() * (i + 1));
    tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

function makeDeck52() {
  var d = [];
  for (var s = 0; s < 4; s++) {
    for (var r = 0; r < 13; r++) {
      d.push({ r: r, s: s });
    }
  }
  return shuffle(d);
}

/* Deal TL: 52 cards → 4 hands of 13 */
function dealTL() {
  var deck = makeDeck52();
  var hands = [[], [], [], []];
  for (var i = 0; i < 52; i++) hands[i % 4].push(deck[i]);
  /* Sort each hand: rank * 4 + suit */
  hands.forEach(function (h) {
    h.sort(function (a, b) { return (a.r * 4 + a.s) - (b.r * 4 + b.s); });
  });
  /* Find who has 3♠ (r=0, s=0) */
  var firstTurn = 0;
  outer: for (var p = 0; p < 4; p++) {
    for (var j = 0; j < hands[p].length; j++) {
      if (hands[p][j].r === 0 && hands[p][j].s === 0) { firstTurn = p; break outer; }
    }
  }
  return { hands: hands, currentTurn: firstTurn };
}

/* Deal XD: 2 cards each for player + dealer */
function dealXD() {
  var deck = makeDeck52();
  return {
    player: [deck.pop(), deck.pop()],
    dealer:  [deck.pop(), deck.pop()]
  };
}

/* ============================================================
   ROOMS
   ============================================================ */
var rooms = {}; /* code → Room */

function Room(code, game, maxPlayers) {
  this.code       = code;
  this.game       = game;          /* 'tl' | 'xd' */
  this.maxPlayers = maxPlayers;    /* tl=4, xd=2 */
  this.players    = [];            /* [{ name, ws, id }] */
  this.started    = false;
}

function getRoom(code) { return rooms[code] || null; }

function cleanRooms() {
  /* Remove empty or stale rooms */
  Object.keys(rooms).forEach(function (code) {
    var r = rooms[code];
    var alive = r.players.filter(function (p) {
      return p.ws && p.ws.readyState === WebSocket.OPEN;
    });
    if (alive.length === 0) delete rooms[code];
    else r.players = alive;
  });
}

/* ============================================================
   MESSAGE HANDLERS
   ============================================================ */
wss.on('connection', function (ws) {
  ws._roomCode = null;

  ws.on('message', function (raw) {
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    switch (msg.type) {

      case 'create': {
        cleanRooms();
        var game       = msg.game === 'xd' ? 'xd' : 'tl';
        var maxPlayers = game === 'xd' ? 2 : 4;
        var code = uid();
        while (rooms[code]) code = uid(); /* ensure unique */
        var room = new Room(code, game, maxPlayers);
        room.players.push({ name: msg.name || 'Host', ws: ws, id: 0 });
        rooms[code] = room;
        ws._roomCode = code;

        send(ws, { type: 'created', code: code, maxPlayers: maxPlayers });
        broadcast(room, {
          type: 'players',
          players: room.players.map(function (p) { return p.name; }),
          count: room.players.length,
          max: maxPlayers
        });
        break;
      }

      case 'join': {
        var code = (msg.code || '').toUpperCase();
        var room = getRoom(code);
        if (!room) { send(ws, { type: 'error', message: 'Room not found: ' + code }); return; }
        if (room.started) { send(ws, { type: 'error', message: 'Game already started' }); return; }
        if (room.players.length >= room.maxPlayers) { send(ws, { type: 'error', message: 'Room full' }); return; }

        room.players.push({ name: msg.name || 'Player', ws: ws, id: room.players.length });
        ws._roomCode = code;

        send(ws, { type: 'joined', code: code });
        broadcast(room, {
          type: 'players',
          players: room.players.map(function (p) { return p.name; }),
          count: room.players.length,
          max: room.maxPlayers
        });
        break;
      }

      case 'start': {
        var code = ws._roomCode;
        var room = code ? getRoom(code) : null;
        if (!room) { send(ws, { type: 'error', message: 'No room' }); return; }
        if (room.started) return;
        if (room.players[0].ws !== ws) { send(ws, { type: 'error', message: 'Only host can start' }); return; }
        if (room.players.length < 2) { send(ws, { type: 'error', message: 'Need at least 2 players' }); return; }

        room.started = true;

        if (room.game === 'tl') {
          /* Fill with bots to reach 4 */
          while (room.players.length < 4) {
            room.players.push({ name: 'Bot ' + room.players.length, ws: null, id: room.players.length });
          }
          var deal = dealTL();
          /* Each human gets their own hand; bots get their hands too but aren't connected */
          room.players.forEach(function (p, idx) {
            if (p.ws && p.ws.readyState === WebSocket.OPEN) {
              send(p.ws, {
                type: 'start_tl',
                hands: deal.hands,           /* send all hands — client shows backs for others */
                currentTurn: deal.currentTurn,
                yourIndex: idx
              });
            }
          });

        } else if (room.game === 'xd') {
          var deal = dealXD();
          room.players.forEach(function (p, idx) {
            if (p.ws && p.ws.readyState === WebSocket.OPEN) {
              send(p.ws, {
                type: 'start_xd',
                player: deal.player,
                dealer: deal.dealer
              });
            }
          });
        }
        break;
      }

      case 'move': {
        /* Relay a player move to all others in the room */
        var code = ws._roomCode;
        var room = code ? getRoom(code) : null;
        if (!room) return;

        /* Find sender's index */
        var senderIdx = -1;
        room.players.forEach(function (p, i) { if (p.ws === ws) senderIdx = i; });
        if (senderIdx === -1) return;

        var relayMsg = Object.assign({}, msg, { pid: senderIdx });
        room.players.forEach(function (p) {
          if (p.ws && p.ws !== ws && p.ws.readyState === WebSocket.OPEN) {
            send(p.ws, relayMsg);
          }
        });
        break;
      }

      case 'leave': {
        var code = ws._roomCode;
        var room = code ? getRoom(code) : null;
        if (room) {
          room.players = room.players.filter(function (p) { return p.ws !== ws; });
          if (room.players.length === 0) delete rooms[code];
          else broadcast(room, {
            type: 'players',
            players: room.players.map(function (p) { return p.name; }),
            count: room.players.length,
            max: room.maxPlayers
          });
        }
        ws._roomCode = null;
        break;
      }
    }
  });

  ws.on('close', function () {
    var code = ws._roomCode;
    var room = code ? getRoom(code) : null;
    if (room) {
      room.players = room.players.filter(function (p) { return p.ws !== ws; });
      if (room.players.length === 0) {
        delete rooms[code];
      } else {
        broadcast(room, {
          type: 'players',
          players: room.players.map(function (p) { return p.name; }),
          count: room.players.length,
          max: room.maxPlayers
        });
      }
    }
  });
});
