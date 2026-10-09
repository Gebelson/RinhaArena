import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { openAuthGate } from '../auth.js';
import { restoreSession, signIn, signOut, signUp, resendConfirmation, requestPasswordReset, updatePassword } from '../../net/account.js';

// A small DOM fixture exercises the actual event handlers without a browser or network.
class Element extends EventTarget {
  constructor(tag = 'div') {
    super();
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.value = ''; this.disabled = false;
    this.required = false; this._text = ''; this._classes = new Set();
    this.classList = {
      add: (...names) => names.forEach(name => this._classes.add(name)),
      remove: (...names) => names.forEach(name => this._classes.delete(name)),
      contains: name => this._classes.has(name),
      toggle: (name, force) => {
        const enabled = force ?? !this._classes.has(name);
        if (enabled) this._classes.add(name); else this._classes.delete(name);
        return enabled;
      },
    };
  }
  set className(value) { this._classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  set textContent(value) { this._text = value; this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(html) {
    this.children = []; this._text = ''; const stack = [this];
    for (const token of html.matchAll(/<[^>]+>|[^<]+/g)) {
      const part = token[0];
      if (part.startsWith('</')) { stack.pop(); continue; }
      if (!part.startsWith('<')) { stack.at(-1)._text += part; continue; }
      const tag = part.match(/^<(\w+)/)?.[1];
      if (!tag) continue;
      const child = new Element(tag);
      for (const attr of part.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) {
        const [name, value] = [attr[1], attr[2] ?? ''];
        if (name === tag) continue;
        if (name === 'class') child.className = value;
        else if (name === 'required') child.required = true;
        else if (name === 'minlength') child.minLength = Number(value);
        else child[name] = value;
      }
      stack.at(-1).appendChild(child);
      if (!['input', 'img', 'br'].includes(tag)) stack.push(child);
    }
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  matches(selector) { return selector.startsWith('.') ? this.classList.contains(selector.slice(1)) : this.tagName === selector.toUpperCase(); }
  querySelector(selector) {
    for (const child of this.children) {
      if (child.matches(selector)) return child;
      const result = child.querySelector(selector); if (result) return result;
    }
    return null;
  }
  get elements() {
    const result = {};
    const collect = node => { for (const child of node.children) { if (child.name) result[child.name] = child; collect(child); } };
    collect(this); return result;
  }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  checkValidity() { return !this.required && !this.value || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.value); }
  focus() { document.activeElement = this; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
}

const trackedGlobals = ['fetch', 'document', 'location', 'history', 'localStorage'];
let originalGlobals;
beforeEach(async () => {
  originalGlobals = new Map(trackedGlobals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  globalThis.fetch = async () => { throw new Error('Unexpected request outside the fake server.'); };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  await signOut();
});
afterEach(async () => {
  globalThis.fetch = async () => { throw new Error('Unexpected request outside the fake server.'); };
  await signOut();
  for (const [name, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
  }
});

const user = { id: 'test-player', email: 'player@example.test', user_metadata: { nickname: 'Player' } };
const profile = { id: user.id, nickname: 'Player' };
const session = () => ({ access_token: 'fake-access', refresh_token: 'fake-refresh', expires_in: 3600, user });
const response = (body, status = 200) => Response.json(body, { status });
const tick = () => new Promise(resolve => setImmediate(resolve));
const dispatch = (element, type) => element.dispatchEvent(new Event(type, { cancelable: true }));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(handler, hash = '') {
  const values = new Map(), calls = [], authenticated = [];
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  globalThis.location = new URL('https://rinhaarena.vercel.app/releases/old-version/index.html' + hash);
  globalThis.history = { state: null, replaceState(state, title, url) { globalThis.location = new URL(url, location.href); } };
  globalThis.document = { createElement: tag => new Element(tag), activeElement: null };
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url);
    const call = { path: parsed.pathname + parsed.search, method: options.method, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    return handler(call);
  };
  const root = new Element(); let practiceCount = 0;
  const overlay = openAuthGate(root, { onAuthenticated: account => authenticated.push(account), onPractice: () => { practiceCount++; } });
  const form = overlay.querySelector('.auth-form');
  return {
    overlay, form, calls, authenticated, values,
    title: form.querySelector('h1'), message: form.querySelector('.auth-message'),
    submit: form.querySelector('.auth-submit'), forgot: form.querySelector('.auth-forgot'), resend: form.querySelector('.auth-resend'),
    switchMode: overlay.querySelector('.auth-switch'), practice: overlay.querySelector('.auth-practice'),
    ...form.elements, get practiceCount() { return practiceCount; },
  };
}
const normalAccount = call => {
  if (call.path === '/auth/v1/token?grant_type=password') return response(session());
  if (call.path === '/auth/v1/user') return response(user);
  if (call.path.startsWith('/rest/v1/player_profiles?')) return response([profile]);
  throw new Error('Unexpected auth path: ' + call.path);
};

test('confirmed login uses email and password and never sends an authentication email', async () => {
  const f = fixture(normalAccount); await f.overlay.ready;
  f.email.value = ' PLAYER@example.test '; f.password.value = 'existing-password';
  dispatch(f.form, 'submit'); await tick();
  assert.deepEqual(f.calls.map(call => call.path), ['/auth/v1/token?grant_type=password', '/rest/v1/player_profiles?id=eq.test-player&select=*']);
  assert.deepEqual(f.calls[0].body, { email: 'player@example.test', password: 'existing-password' });
  assert.equal(f.authenticated.length, 1);
  assert.equal(f.resend.classList.contains('hidden'), true);
});

test('pending signup locks mode and duplicate submits and sends signup only once', async () => {
  const waiting = deferred();
  const f = fixture(call => {
    assert.equal(call.path, '/auth/v1/signup'); return waiting.promise;
  });
  await f.overlay.ready;
  dispatch(f.switchMode, 'click'); f.nickname.value = 'Player'; f.email.value = user.email; f.password.value = 'new-password';
  dispatch(f.form, 'submit');
  for (const control of [f.submit, f.switchMode, f.forgot, f.resend, f.nickname, f.email, f.password, f.practice].filter(Boolean)) assert.equal(control.disabled, true);
  dispatch(f.form, 'submit'); dispatch(f.switchMode, 'click'); dispatch(f.forgot, 'click');
  assert.equal(f.title.textContent, 'CADASTRO'); assert.equal(f.calls.length, 1);
  waiting.resolve(response({ user: { ...user, identities: [{ id: 'identity' }] } })); await tick();
  assert.match(f.message.textContent, /uma única vez/); assert.equal(f.resend.classList.contains('hidden'), false);
  if (f.practice) assert.equal(f.practice.disabled, false); assert.equal(f.switchMode.disabled, false);
  dispatch(f.form, 'submit'); await tick(); assert.equal(f.calls.length, 1);
  dispatch(f.switchMode, 'click'); dispatch(f.resend, 'click'); await tick();
  assert.equal(f.title.textContent, 'LOGIN'); assert.equal(f.resend.classList.contains('hidden'), true); assert.equal(f.calls.length, 1);
  dispatch(f.switchMode, 'click'); dispatch(f.form, 'submit'); await tick(); assert.equal(f.calls.length, 1);
});

test('unconfirmed login stays in login and opens its existing pending signup without a new signup', async () => {
  const f = fixture(call => {
    if (call.path === '/auth/v1/token?grant_type=password') return response({ msg: 'Email not confirmed', error_code: 'email_not_confirmed' }, 400);
    if (call.path === '/auth/v1/resend') return response({});
    throw new Error('Unexpected auth path: ' + call.path);
  });
  await f.overlay.ready; f.email.value = user.email; f.password.value = 'existing-password';
  dispatch(f.form, 'submit'); await tick();
  assert.equal(f.title.textContent, 'LOGIN');
  assert.equal(f.message.textContent, 'Seu cadastro ainda está pendente. Conclua o cadastro para ativar sua conta.');
  assert.equal(f.resend.classList.contains('hidden'), true); assert.match(f.switchMode.textContent, /CONCLUIR CADASTRO/);
  dispatch(f.resend, 'click'); await tick(); assert.equal(f.calls.length, 1);
  dispatch(f.switchMode, 'click'); dispatch(f.form, 'submit'); await tick();
  assert.equal(f.title.textContent, 'CADASTRO'); assert.equal(f.calls.length, 1); assert.equal(f.resend.disabled, false);
  f.email.value = 'different@example.test'; dispatch(f.email, 'input'); dispatch(f.resend, 'click'); await tick();
  assert.equal(f.resend.classList.contains('hidden'), true); assert.equal(f.resend.disabled, true); assert.equal(f.calls.length, 1);
  f.email.value = user.email; dispatch(f.email, 'input'); dispatch(f.resend, 'click'); await tick();
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].path, '/auth/v1/resend'); assert.equal(f.calls[1].body.email, user.email);
});

test('backend error codes are retained and unrelated confirmation errors do not expose resend', async () => {
  const f = fixture(() => response({ msg: 'Confirmation service unavailable', error_code: 'validation_failed' }, 400));
  await f.overlay.ready; f.email.value = user.email; f.password.value = 'existing-password';
  dispatch(f.form, 'submit'); await tick();
  assert.equal(f.resend.classList.contains('hidden'), true); assert.doesNotMatch(f.switchMode.textContent, /CONCLUIR/);
  await assert.rejects(signIn(user.email, 'existing-password'), error => error.code === 'validation_failed' && error.status === 400);
});

test('password recovery requests cannot overlap and release every control after success', async () => {
  const waiting = deferred(); const f = fixture(() => waiting.promise);
  await f.overlay.ready; f.email.value = user.email;
  dispatch(f.forgot, 'click'); dispatch(f.forgot, 'click'); dispatch(f.form, 'submit'); dispatch(f.switchMode, 'click');
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/auth/v1/recover');
  waiting.resolve(response({})); await tick();
  for (const control of [f.submit, f.switchMode, f.forgot, f.nickname, f.email, f.password, f.practice].filter(Boolean)) assert.equal(control.disabled, false);
  assert.equal(f.message.classList.contains('error'), false); assert.match(f.message.textContent, /instruções de recuperação/);
  if (f.practice) { dispatch(f.practice, 'click'); assert.equal(f.practiceCount, 1); }
});

test('password saved with failed session restoration returns to usable email and password login', async () => {
  let saved = false;
  const f = fixture(call => {
    if (call.path === '/auth/v1/user' && call.method === 'PUT') { saved = true; return response(user); }
    if (call.path === '/auth/v1/user' && saved) return response({ msg: 'Invalid session', error_code: 'bad_jwt' }, 401);
    return normalAccount(call);
  }, '#access_token=fake-access&refresh_token=fake-refresh&expires_in=3600&type=recovery');
  await f.overlay.ready;
  assert.equal(f.title.textContent, 'NOVA SENHA'); f.password.value = 'updated-password';
  dispatch(f.form, 'submit'); await tick();
  assert.equal(f.title.textContent, 'LOGIN'); assert.equal(f.submit.textContent, 'ENTRAR');
  assert.equal(f.email.closest('label').classList.contains('hidden'), false); assert.equal(f.email.required, true);
  assert.equal(f.switchMode.classList.contains('hidden'), false); assert.equal(f.forgot.classList.contains('hidden'), false);
  assert.equal(f.password.value, ''); assert.equal(f.password.minLength, 6); assert.equal(f.password.autocomplete, 'current-password');
  assert.match(f.message.textContent, /Senha atualizada.*nova senha/); if (f.practice) assert.equal(f.practice.disabled, false);
  f.email.value = user.email; f.password.value = 'updated-password'; dispatch(f.form, 'submit'); await tick();
  assert.equal(f.authenticated.length, 1); assert.equal(f.calls.at(-2).path, '/auth/v1/token?grant_type=password');
});

test('expired recovery authorization exposes login and the password recovery action', async () => {
  const f = fixture(call => {
    if (call.path === '/auth/v1/user' && call.method === 'PUT') return response({ msg: 'Invalid JWT', error_code: 'bad_jwt' }, 401);
    return normalAccount(call);
  }, '#access_token=fake-access&expires_in=3600&type=recovery');
  await f.overlay.ready; f.password.value = 'updated-password'; dispatch(f.form, 'submit'); await tick();
  assert.equal(f.title.textContent, 'LOGIN'); assert.equal(f.forgot.classList.contains('hidden'), false);
  assert.match(f.message.textContent, /Use ESQUECI MINHA SENHA/); assert.equal(f.email.disabled, false);
});

test('invalid email link is reported and removed from the address', async () => {
  const f = fixture(() => { throw new Error('No request should be sent for an invalid link.'); }, '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
  await f.overlay.ready;
  assert.match(f.message.textContent, /link é inválido ou expirou/); assert.equal(f.message.classList.contains('error'), true);
  assert.equal(f.overlay.classList.contains('auth-checking'), false); assert.equal(location.hash, ''); assert.equal(f.calls.length, 0);
});

test('all authentication email return URLs use the site root when opened from a release path', async () => {
  const f = fixture(call => call.path === '/auth/v1/signup' ? response({ user: { ...user, identities: [{ id: 'identity' }] } }) : response({}));
  await f.overlay.ready;
  assert.deepEqual(await signUp({ nickname: 'Player', email: user.email, password: 'new-password' }), { confirmationRequired: true });
  await resendConfirmation(user.email); await requestPasswordReset(user.email);
  assert.equal(f.calls[0].body.email_redirect_to, 'https://rinhaarena.vercel.app/');
  assert.equal(f.calls[1].body.email_redirect_to, 'https://rinhaarena.vercel.app/');
  assert.equal(f.calls[2].body.redirect_to, 'https://rinhaarena.vercel.app/');
});

test('recovery requirement survives restoring and refreshing the session until the password is saved', async () => {
  const f = fixture(call => call.path === '/auth/v1/token?grant_type=refresh_token' ? response(session()) : normalAccount(call), '#access_token=fake-access&refresh_token=fake-refresh&expires_in=3600&type=recovery');
  await f.overlay.ready;
  assert.equal((await restoreSession()).recoveryRequired, true);
  const stored = JSON.parse(f.values.get('rinha.auth.session')); stored.expires_at = Date.now() / 1000 - 10;
  localStorage.setItem('rinha.auth.session', JSON.stringify(stored));
  assert.equal((await restoreSession()).recoveryRequired, true);
  assert.equal(f.calls.some(call => call.path === '/auth/v1/token?grant_type=refresh_token'), true);
  await updatePassword('updated-password');
  assert.equal((await restoreSession()).recoveryRequired, false);
});
