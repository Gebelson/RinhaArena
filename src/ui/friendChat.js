import * as chatApi from '../net/friendChat.js';
import { getAvatarUrl } from '../content/avatars.js';

const PAGE_SIZE = 40;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const orderMessages = (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)
  || (a.created_at.match(/\.(\d+)/)?.[1] || '').padEnd(6, '0').localeCompare((b.created_at.match(/\.(\d+)/)?.[1] || '').padEnd(6, '0'))
  || a.id.localeCompare(b.id);

// One authenticated subscription per account, shared by all private conversations.
export function createFriendChat(root, profile, { services = chatApi, onUnreadChange = () => {} } = {}) {
  let owner = null, subscription = null, overlay = null, active = null, connected = false;
  let epoch = 0, fallbackTimer = 0, refreshTimer = 0, syncingUnread = false, unreadRefreshQueued = false;
  let unread = new Map();
  const conversations = new Map();
  const listeners = new Set();
  const mergeMessage = (conversation, row) => {
    const known = conversation.rows.get(row.id);
    const merged = known?.read_at && !row.read_at ? { ...row, read_at:known.read_at } : row;
    conversation.rows.set(row.id, merged); conversation.pending.delete(row.client_nonce);
    conversation.liveChanges?.set(row.id, merged);
  };
  const notify = () => {
    const snapshot = new Map(unread);
    onUnreadChange(snapshot);
    for (const listener of listeners) listener(snapshot);
  };
  const validOwner = value => owner === value && profile.playerId === value;
  const nearBottom = () => {
    const log = overlay?.querySelector('.friend-chat-log');
    return log && log.scrollHeight - log.scrollTop - log.clientHeight < 70;
  };
  const canRead = () => overlay?.isConnected && document.visibilityState === 'visible' && nearBottom();
  const showError = text => {
    if (overlay) overlay.querySelector('.friend-chat-error').textContent = text;
  };
  async function refreshUnread() {
    if (!owner) return;
    if (syncingUnread) { unreadRefreshQueued = true; return; }
    const currentOwner = owner;
    syncingUnread = true;
    try {
      const rows = await services.listFriendChatUnread(currentOwner);
      if (!validOwner(currentOwner)) return;
      unread = new Map(rows.map(row => [row.friend_id, Math.max(0, Number(row.unread_count) || 0)]));
      notify();
    } catch { /* A missed notification is reconciled on reconnect or focus. */ }
    finally { syncingUnread = false; if (unreadRefreshQueued) { unreadRefreshQueued = false; queueRefresh(); } }
  }
  function queueRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshUnread, 200);
  }
  async function markRead(conversation) {
    if (!owner || active !== conversation || !canRead() || conversation.marking) return;
    const currentOwner = owner;
    conversation.marking = true;
    try {
      await services.markFriendMessagesRead(currentOwner, conversation.friend.id);
      if (validOwner(currentOwner)) await refreshUnread();
    } catch { /* Retried when another message arrives or the conversation regains focus. */ }
    finally { conversation.marking = false; }
  }
  function render(conversation, { bottom = false, preserve = false } = {}) {
    if (!overlay || active !== conversation) return;
    const log = overlay.querySelector('.friend-chat-log');
    const oldHeight = log.scrollHeight, oldTop = log.scrollTop;
    const rows = [...conversation.rows.values()].sort(orderMessages);
    log.replaceChildren();
    if (!rows.length && !conversation.pending.size) {
      const empty = document.createElement('p'); empty.className = 'friend-chat-empty';
      empty.textContent = conversation.loading ? 'Carregando conversa…' : 'Comece uma conversa com seu amigo.';
      log.append(empty);
    }
    for (const message of [...rows, ...conversation.pending.values()]) {
      const own = message.sender_id === owner;
      const article = document.createElement('article'); article.className = `friend-chat-message${own ? ' own' : ''}`;
      article.dataset.messageId = message.id || message.client_nonce;
      const text = document.createElement('p'); text.textContent = message.body;
      const detail = document.createElement('small');
      const time = new Date(message.created_at);
      detail.textContent = `${own ? 'Você' : conversation.friend.nickname} · ${time.toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}${own ? ` · ${message.failed ? 'Não enviada' : message.pending ? 'Enviando…' : message.read_at ? 'Lida' : 'Enviada'}` : ''}`;
      article.append(text, detail);
      if (message.failed) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'TENTAR NOVAMENTE';
        retry.addEventListener('click', () => deliver(conversation, message)); article.append(retry);
      }
      log.append(article);
    }
    overlay.querySelector('.friend-chat-older').hidden = !conversation.hasMore;
    overlay.querySelector('.friend-chat-older').disabled = conversation.loading;
    if (bottom) log.scrollTop = log.scrollHeight;
    else if (preserve) log.scrollTop = oldTop + log.scrollHeight - oldHeight;
    else log.scrollTop = oldTop;
  }
  async function loadPage(conversation, older = false) {
    if (!owner) return;
    if (conversation.loading) { if (!older) conversation.refreshQueued = true; return; }
    const currentOwner = owner, requestEpoch = epoch;
    conversation.loading = true;
    const liveChanges = new Map(); conversation.liveChanges = liveChanges;
    render(conversation);
    try {
      const rows = await services.getFriendMessages(currentOwner, conversation.friend.id, older ? conversation.cursor : null, PAGE_SIZE);
      if (!validOwner(currentOwner) || epoch !== requestEpoch) return;
      // Replace history on reconnect so a long offline interval cannot leave a hidden gap.
      if (!older) conversation.rows.clear();
      for (const row of rows) { conversation.rows.set(row.id, row); conversation.pending.delete(row.client_nonce); }
      for (const row of liveChanges.values()) { conversation.rows.set(row.id, row); conversation.pending.delete(row.client_nonce); }
      const first = [...rows].sort(orderMessages)[0];
      conversation.cursor = first ? { created_at:first.created_at, id:first.id } : conversation.cursor;
      conversation.hasMore = rows.length === PAGE_SIZE;
      conversation.loaded = true;
      render(conversation, { bottom:!older, preserve:older });
      await markRead(conversation);
    } catch (error) { if (active === conversation) showError(error.message || 'Não foi possível carregar a conversa.'); }
    finally {
      conversation.loading = false;
      conversation.liveChanges = null;
      render(conversation);
      if (overlay && active === conversation) overlay.querySelector('.friend-chat-refresh').disabled = false;
      if (conversation.refreshQueued && validOwner(currentOwner) && active === conversation) {
        conversation.refreshQueued = false; loadPage(conversation);
      }
    }
  }
  async function deliver(conversation, message) {
    if (!owner || message.sending) return;
    const currentOwner = owner;
    message.sending = true; message.pending = true; message.failed = false;
    showError(''); render(conversation, { bottom:true });
    try {
      const row = await services.sendFriendMessage(currentOwner, conversation.friend.id, message.body, message.client_nonce);
      if (!validOwner(currentOwner)) return;
      mergeMessage(conversation, row);
      render(conversation, { bottom:true });
    } catch (error) {
      message.failed = true; message.pending = false;
      if (validOwner(currentOwner) && active === conversation) { showError(error.message || 'Não foi possível enviar. Tente novamente.'); render(conversation, { bottom:true }); }
    } finally { message.sending = false; }
  }
  function close() {
    overlay?.remove(); overlay = null; active = null;
    document.removeEventListener('keydown', onKey);
  }
  function onKey(event) {
    if (event.key === 'Escape' && overlay) { event.preventDefault(); event.stopPropagation(); close(); }
    if (event.key === 'Tab' && overlay) {
      const controls = [...overlay.querySelectorAll('button:not(:disabled), textarea, [tabindex="0"]')].filter(control => !control.hidden && control.offsetParent !== null);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }
  function open(friend) {
    if (!owner) start(profile.playerId);
    if (!owner || !friend?.id) return;
    close();
    const previousFocus = document.activeElement;
    let conversation = conversations.get(friend.id);
    if (!conversation) {
      conversation = { friend, rows:new Map(), pending:new Map(), cursor:null, hasMore:false, loaded:false, loading:false, marking:false };
      conversations.set(friend.id, conversation);
    }
    conversation.friend = friend; active = conversation;
    overlay = document.createElement('div'); overlay.className = 'modal-overlay friend-chat-overlay';
    overlay.innerHTML = `<section class="modal-window friend-chat-window" role="dialog" aria-modal="true" aria-label="Conversa com ${escapeHtml(friend.nickname)}">
      <header class="modal-header"><img class="friend-chat-avatar" src="${getAvatarUrl(friend.avatar)}" alt=""><div><span class="friend-chat-eyebrow">CHAT ENTRE AMIGOS</span><div class="modal-title">${escapeHtml(friend.nickname)}</div><small class="friend-chat-connection" role="status"></small></div><button class="modal-close" aria-label="Fechar conversa">✕</button></header>
      <div class="friend-chat-tools"><button class="friend-chat-older" type="button" hidden>MENSAGENS ANTERIORES</button><button class="friend-chat-refresh" type="button" aria-label="Atualizar conversa">↻</button><span>Conversa privada</span></div>
      <div class="friend-chat-log" role="log" aria-label="Mensagens" aria-live="polite" aria-relevant="additions text" tabindex="0"></div>
      <p class="friend-chat-error" role="alert"></p>
      <form class="friend-chat-compose"><label class="friend-chat-input-label" for="friend-chat-input">Mensagem</label><textarea id="friend-chat-input" maxlength="1000" rows="2" placeholder="Escreva uma mensagem…"></textarea><button type="submit" disabled>ENVIAR</button><small>Enter envia · Shift + Enter quebra a linha</small><span class="friend-chat-count">0/1000</span></form>
    </section>`;
    root.append(overlay);
    const input = overlay.querySelector('textarea'), send = overlay.querySelector('[type="submit"]');
    overlay.querySelector('.friend-chat-connection').textContent = connected ? 'Mensagens em tempo real' : 'Reconectando…';
    overlay.querySelector('.modal-close').addEventListener('click', () => { close(); previousFocus?.focus?.(); });
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    overlay.querySelector('.friend-chat-log').addEventListener('scroll', () => { if (unread.get(friend.id)) markRead(conversation); });
    overlay.querySelector('.friend-chat-older').addEventListener('click', () => loadPage(conversation, true));
    overlay.querySelector('.friend-chat-refresh').addEventListener('click', event => { event.currentTarget.disabled = true; showError(''); loadPage(conversation); });
    input.addEventListener('input', () => { send.disabled = !input.value.trim(); overlay.querySelector('.friend-chat-count').textContent = `${input.value.length}/1000`; });
    overlay.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      const body = input.value.trim(); if (!body || body.length > 1000) return;
      const message = { sender_id:owner, recipient_id:friend.id, body, client_nonce:crypto.randomUUID(), created_at:new Date().toISOString(), pending:true };
      conversation.pending.set(message.client_nonce, message); input.value = ''; send.disabled = true;
      overlay.querySelector('.friend-chat-count').textContent = '0/1000'; deliver(conversation, message);
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); overlay.querySelector('form').requestSubmit(); }
    });
    overlay.addEventListener('keydown', event => { onKey(event); event.stopPropagation(); });
    document.addEventListener('keydown', onKey);
    render(conversation, { bottom:true }); input.focus(); loadPage(conversation);
  }
  function start(playerId) {
    if (!playerId || owner === playerId) return;
    stop(); owner = playerId; epoch++;
    subscription = services.subscribeFriendMessages(owner, {
      onMessage(row) {
        if (!validOwner(playerId)) return;
        const friendId = row.sender_id === owner ? row.recipient_id : row.sender_id;
        const conversation = conversations.get(friendId);
        if (conversation) {
          const bottom = nearBottom();
          mergeMessage(conversation, row);
          render(conversation, { bottom });
          if (active === conversation && bottom) markRead(conversation);
        }
        queueRefresh();
      },
      onStatus(status) {
        if (!validOwner(playerId)) return;
        connected = status === 'connected';
        if (overlay) overlay.querySelector('.friend-chat-connection').textContent = connected ? 'Mensagens em tempo real' : 'Reconectando…';
        if (connected) { refreshUnread(); if (active) loadPage(active); }
      },
    });
    refreshUnread();
    fallbackTimer = setInterval(() => {
      if (document.visibilityState !== 'visible' || connected) return;
      refreshUnread(); if (active) loadPage(active);
    }, 15000);
    document.addEventListener('visibilitychange', onFocus);
    window.addEventListener('focus', onFocus);
  }
  function onFocus() {
    if (document.visibilityState !== 'visible' || !owner) return;
    refreshUnread(); if (active) loadPage(active);
  }
  function stop() {
    epoch++; subscription?.close(); subscription = null; owner = null; connected = false;
    clearInterval(fallbackTimer); clearTimeout(refreshTimer); unreadRefreshQueued = false; conversations.clear(); unread.clear(); close(); notify();
    document.removeEventListener('visibilitychange', onFocus); window.removeEventListener('focus', onFocus);
  }
  return { start, stop, open, close, refreshUnread, getUnread:() => new Map(unread), subscribeUnread(listener) { listeners.add(listener); return () => listeners.delete(listener); } };
}
