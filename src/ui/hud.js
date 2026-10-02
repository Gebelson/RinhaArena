// In-match HUD: scoreboard + round timer + flag status, event feed, big
// center announcements (countdown / GOAL / winner), respawn overlay, HP bar,
// exit + mute buttons. Pure DOM over the canvas.

import { TEAMS } from '../core/config.js';
import { getSettings, keyLabel } from '../settings.js';

export function createHud(uiRoot, { onExit, onMute, onSendChat, muted }) {
  const el = document.createElement('div');
  el.className = 'hud';
  el.innerHTML = `
    <div class="topbar">
      <div class="score score-red">0</div>
      <div class="mid">
        <div class="timer">3:00</div>
        <div class="flag-ind"><span class="fi fi-red">⚑</span><span class="fi fi-blue">⚑</span></div>
        <div class="ffa-hud hidden"><span class="ffa-lead">⚔️ FFA</span></div>
      </div>
      <div class="score score-blue">0</div>
    </div>
    <div class="feed"></div>
    <div class="center"></div>
    <div class="respawn hidden"></div>
    <div class="bottom-hud">
      <div class="gloves-hud hidden"><span class="gloves-text">🥊 INSTA-NOCAUTE (20s)</span></div>
      <div class="dash-hud"><div class="dash-fill"></div><span class="dash-text">⚡ DASH [Shift]</span></div>
      <div class="hpwrap"><div class="hpbar"></div></div>
    </div>
    <div class="hud-corner">
      <button class="hud-btn btn-chat" aria-label="Abrir chat">💬</button>
      <button class="hud-btn btn-mute">${muted ? '🔇' : '🔊'}</button>
      <button class="hud-btn btn-exit">✕</button>
    </div>
    <form class="game-chat hidden" autocomplete="off">
      <div class="game-chat-log" aria-live="polite"></div>
      <div class="game-chat-compose"><input maxlength="100" placeholder="Digite uma mensagem…" aria-label="Mensagem do chat"><button type="submit">ENVIAR</button></div>
    </form>
    <div class="connecting hidden">Connecting…</div>
    <div class="overlay-over hidden"></div>
  `;
  uiRoot.appendChild(el);

  const q = (sel) => el.querySelector(sel);
  const scoreRed = q('.score-red');
  const scoreBlue = q('.score-blue');
  const timer = q('.timer');
  const flagInd = q('.flag-ind');
  const feed = q('.feed');
  const center = q('.center');
  const respawn = q('.respawn');
  const hpbar = q('.hpbar');
  const glovesHud = q('.gloves-hud');
  const glovesText = q('.gloves-text');
  const dashHud = q('.dash-hud');
  const dashFill = q('.dash-fill');
  const dashText = q('.dash-text');
  const connecting = q('.connecting');
  const overPanel = q('.overlay-over');
  const ffaHud = q('.ffa-hud');
  const ffaLead = q('.ffa-lead');
  const chat = q('.game-chat');
  const chatLog = q('.game-chat-log');
  const chatInput = q('.game-chat input');

  function appendChatMessage({ displayName, text, own = false } = {}) {
    const safeName = String(displayName || '').trim();
    const safeText = String(text || '').trim();
    if (!safeName || !safeText) return;
    const line = document.createElement('div');
    if (own) line.className = 'own';
    const author = document.createElement('b');
    author.textContent = `${safeName}: `;
    line.append(author, document.createTextNode(safeText));
    chatLog.appendChild(line);
    while (chatLog.children.length > 20) chatLog.firstChild.remove();
    chatLog.scrollTop = chatLog.scrollHeight;
  }

  q('.btn-exit').addEventListener('click', onExit);
  q('.btn-mute').addEventListener('click', (e) => {
    e.currentTarget.textContent = onMute() ? '🔇' : '🔊';
  });
  q('.btn-chat').addEventListener('click', () => {
    if (!getSettings().chat) return;
    chat.classList.toggle('hidden');
    if (!chat.classList.contains('hidden')) chatInput.focus();
  });
  chat.addEventListener('submit', (event) => {
    event.preventDefault();
    const message = chatInput.value.trim();
    if (!message) return;
    onSendChat?.(message);
    chatInput.value = '';
  });
  const onChatKey = (event) => {
    if (event.code === 'Escape' && !chat.classList.contains('hidden')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      chat.classList.add('hidden');
      chatInput.blur();
      return;
    }
    if (event.code === 'Enter' && getSettings().chat && !/INPUT|TEXTAREA/.test(event.target?.tagName)) {
      event.preventDefault();
      chat.classList.remove('hidden');
      chatInput.focus();
    }
  };
  window.addEventListener('keydown', onChatKey);

  let lastCountdown = -1;
  let centerTimer = null;
  let overShown = false;

  function showCenter(html, cls = '', ms = 1300) {
    center.innerHTML = html;
    center.className = `center pop ${cls}`;
    clearTimeout(centerTimer);
    if (ms) centerTimer = setTimeout(() => { center.className = 'center'; center.innerHTML = ''; }, ms);
  }

  function pushFeed(html, cls = '') {
    const item = document.createElement('div');
    item.className = `feed-item ${cls}`;
    item.innerHTML = html;
    feed.appendChild(item);
    while (feed.children.length > 4) feed.firstChild.remove();
    setTimeout(() => { item.classList.add('fade'); setTimeout(() => item.remove(), 500); }, 3200);
  }

  const name = (ev) => `<b style="color:${TEAMS[ev.team]?.color ?? '#fff'}">${ev.name ?? ''}</b>`;

  return {
    update(view, myId) {
      const isFfa = view.modeId === 'ffa' || !!view.ffaScores;
      if (isFfa) {
        scoreRed.style.display = 'none';
        scoreBlue.style.display = 'none';
        flagInd.style.display = 'none';
        if (ffaHud) ffaHud.classList.remove('hidden');
        const myScore = (view.ffaScores && view.ffaScores[myId]) || 0;
        let leaderName = '';
        let leaderScore = -1;
        if (view.ffaScores) {
          for (const [id, sc] of Object.entries(view.ffaScores)) {
            if (sc > leaderScore) {
              leaderScore = sc;
              const lp = view.players.find((p) => p.id === id);
              leaderName = lp ? lp.name : 'Bot';
            }
          }
        }
        if (ffaLead) {
          ffaLead.innerHTML = `⚔️ Frags: <b>${myScore}</b>${leaderName ? ` · Líder: ${leaderName} (${leaderScore})` : ''}`;
        }
      } else {
        scoreRed.style.display = '';
        scoreBlue.style.display = '';
        if (ffaHud) ffaHud.classList.add('hidden');
        scoreRed.textContent = view.scores.red;
        scoreBlue.textContent = view.scores.blue;
      }

      if (view.phase === 'countdown') {
        const n = Math.max(1, Math.ceil(view.countdown));
        timer.textContent = 'READY';
        if (n !== lastCountdown) {
          lastCountdown = n;
          showCenter(String(n), 'big', 900);
        }
      } else if (view.lab) {
        lastCountdown = -1;
        timer.textContent = 'LAB'; // endless sandbox session
        timer.classList.remove('urgent');
      } else {
        lastCountdown = -1;
        const t = Math.max(0, Math.ceil(view.timeLeft));
        timer.textContent = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
        timer.classList.toggle('urgent', t <= 20 && view.phase === 'play');
      }

      // per-team flag status: solid = home, blink = loose, hollow-pulse =
      // being carried by the enemy (you can't score till it's back!)
      flagInd.style.display = view.flags ? '' : 'none';
      if (view.flags) {
        for (const team of ['red', 'blue']) {
          const f = view.flags[team];
          const el = flagInd.querySelector(`.fi-${team}`);
          el.style.color = TEAMS[team].color;
          el.classList.toggle('blink', f.st === 'drop');
          el.classList.toggle('carried', f.st === 'carry');
        }
      }

      const me = view.players.find((p) => p.id === myId);
      if (me) {
        hpbar.style.width = `${Math.max(0, me.hp)}%`;
        hpbar.classList.toggle('low', me.hp < 35);
        if (dashFill && dashText) {
          const cd = me.dashCd || 0;
          if (cd <= 0) {
            dashFill.style.width = '100%';
            dashFill.classList.remove('recharge');
            dashText.textContent = `⚡ DASH [${keyLabel(getSettings().controls.dash)}]`;
            dashHud.classList.add('ready');
          } else {
            const pct = Math.max(0, Math.min(100, (1 - cd / 1.6) * 100));
            dashFill.style.width = `${pct}%`;
            dashFill.classList.add('recharge');
            dashText.textContent = `⚡ DASH (${cd.toFixed(1)}s)`;
            dashHud.classList.remove('ready');
          }
        }
        if (glovesHud) {
          const gT = me.glovesT ?? 0;
          if (gT > 0) {
            glovesHud.classList.remove('hidden');
            glovesText.textContent = `🥊 INSTA-NOCAUTE (${gT.toFixed(1)}s)`;
          } else {
            glovesHud.classList.add('hidden');
          }
        }
        if (me.state === 'ko' && view.phase !== 'over') {
          respawn.classList.remove('hidden');
          respawn.innerHTML = `💥 KNOCKED OUT<span>back in ${Math.max(1, Math.ceil(me.respawn))}…</span>`;
        } else {
          respawn.classList.add('hidden');
        }
      }

      if (view.phase === 'over') {
        // build the card once (rewriting every frame restarts its pop
        // animation and freezes it at the first keyframe), tick only the text
        if (!overShown) {
          overShown = true;
          const w = view.winner;
          let title = '';
          let scoreText = '';
          if (isFfa) {
            const winnerP = view.players.find((p) => p.id === w);
            title = winnerP ? `🏆 <span style="color:#ffd460">${winnerP.name}</span> VENCEU!` : 'EMPATE!';
            const winFrags = (winnerP && view.ffaScores) ? (view.ffaScores[winnerP.id] ?? 0) : 0;
            scoreText = `${winFrags} FRAGS`;
          } else {
            title = w === 'draw'
              ? 'DRAW!'
              : `<span style="color:${TEAMS[w]?.color ?? '#fff'}">${TEAMS[w]?.name ?? w}</span> WINS!`;
            scoreText = `${view.scores.red} — ${view.scores.blue}`;
          }
          overPanel.innerHTML = `
            <div class="over-card">
              <div class="over-title">${title}</div>
              <div class="over-score">${scoreText}</div>
              <div class="over-next"></div>
            </div>`;
          overPanel.classList.remove('hidden');
          if (getSettings().notifications && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            new Notification('Rinha Arena', { body: overPanel.textContent.trim().replace(/\s+/g, ' ') });
          }
        }
        overPanel.querySelector('.over-next').textContent =
          `Next round in ${Math.max(1, Math.ceil(view.overT))}…`;
      } else if (overShown) {
        overShown = false;
        overPanel.classList.add('hidden');
      }
    },

    pushEvents(events, view, myId) {
      const tname = (team) => `<b style="color:${TEAMS[team].color}">${TEAMS[team].name}</b>`;
      const pname = (id) => {
        const p = view.players.find((p) => p.id === id);
        return p ? `<b style="color:${TEAMS[p.team].color}">${p.name}</b>` : 'Someone';
      };
      const tag = (n, team) => `<b style="color:${TEAMS[team]?.color ?? '#fff'}">${n ?? 'Someone'}</b>`;
      // Death Match emits a `frag` alongside the generic `ko` for the same
      // death — suppress the generic line so the feed doesn't double up.
      const fragged = new Set(events.filter((e) => e.t === 'frag').map((e) => e.victim));
      for (const ev of events) {
        switch (ev.t) {
          case 'flagSteal':
            pushFeed(`🚩 ${pname(ev.id)} stole the ${tname(ev.team)} flag!`);
            break;
          case 'flagThrow':
            pushFeed(`🚩 ${pname(ev.id)} hurled the ${tname(ev.team)} flag!`);
            break;
          case 'flagDrop':
            pushFeed(`🚩 The ${tname(ev.team)} flag is loose!`);
            break;
          case 'flagReturn':
            pushFeed(ev.by
              ? `🏳️ <b>${ev.by}</b> returned the ${tname(ev.team)} flag`
              : `🏳️ The ${tname(ev.team)} flag returned home`);
            break;
          case 'flagVoid':
            pushFeed(`🕳️ The ${tname(ev.team)} flag fell into the void!`);
            break;
          case 'scoreBlocked':
            if (ev.id === myId) pushFeed('🚫 Your flag must be home to score!', 'warn');
            break;
          case 'score':
            pushFeed(`🏆 ${name(ev)} captures for ${TEAMS[ev.team].name}!`);
            showCenter('CAPTURE!', `goal-${ev.team}`, 1500);
            break;
          case 'ko':
            if (fragged.has(ev.id)) break;
            pushFeed(
              ev.cause === 'fall' ? `🕳️ ${name(ev)} fell into the void`
              : ev.cause === 'punch' ? `🥊 ${name(ev)} levou INSTA-NOCAUTE!`
              : ev.cause === 'shatter' ? `🧊 ${name(ev)} was shattered`
              : ev.cause === 'curse' ? `💀 the curse claimed ${name(ev)}`
              : `💥 ${name(ev)} was blown up`,
            );
            break;
          case 'frag':
            pushFeed(
              ev.killerName
                ? `⚔️ ${tag(ev.killerName, ev.killerTeam)} fragged ${tag(ev.victimName, ev.victimTeam)}`
                : `💀 ${tag(ev.victimName, ev.victimTeam)} self-destructed`,
            );
          case 'curse':
            pushFeed(`💀 ${pname(ev.id)} is CURSED — find a med-pack!`, 'warn');
            break;
          case 'playerThrow':
            pushFeed(`🤾 ${pname(ev.id)} threw ${pname(ev.target)}!`);
            break;
          case 'leave':
            pushFeed(`👋 ${ev.name} left`);
            break;
        }
      }
    },

    setConnecting(on) {
      connecting.classList.toggle('hidden', !on);
    },

    pushChatMessages(messages) {
      for (const message of messages || []) appendChatMessage(message);
    },

    isChatOpen() { return !chat.classList.contains('hidden'); },
    closeChat() { chat.classList.add('hidden'); chatInput.blur(); },

    dispose() {
      clearTimeout(centerTimer);
      window.removeEventListener('keydown', onChatKey);
      el.remove();
    },
  };
}
