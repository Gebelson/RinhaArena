import { requestPasswordReset, resendConfirmation, restoreSession, signIn, signUp, updatePassword } from '../net/account.js';

export function openAuthGate(uiRoot, { onAuthenticated }) {
  const overlay = document.createElement('div');
  overlay.className = 'auth-overlay auth-checking';
  overlay.innerHTML = `
    <section class="auth-window" role="dialog" aria-modal="true" aria-label="Login Rinha Arena">
      <div class="auth-art" aria-hidden="true">
        <img class="auth-logo" src="./assets/ui/logo-rinha-arena.webp" alt="" />
      </div>
      <div class="auth-panel">
        <form class="auth-form">
          <h1>LOGIN</h1>
          <label class="signup-only hidden">NICKNAME<input name="nickname" maxlength="12" autocomplete="nickname" /></label>
          <label>E-MAIL<input name="email" type="email" autocomplete="email" required /></label>
          <label>SENHA<input name="password" type="password" minlength="6" autocomplete="current-password" required /></label>
          <div class="auth-actions"><button class="auth-forgot" type="button">ESQUECI MINHA SENHA</button><button class="auth-submit" type="submit">ENTRAR</button></div>
          <p class="auth-message" role="status"></p>
          <button class="auth-resend hidden" type="button">REENVIAR E-MAIL DE CONFIRMAÇÃO</button>
        </form>
        <button class="auth-switch" type="button">AINDA NÃO TEM CONTA? <u>CADASTRE-SE</u></button>
      </div>
    </section>`;
  uiRoot.appendChild(overlay);

  const form = overlay.querySelector('.auth-form');
  const title = form.querySelector('h1');
  const nicknameRow = form.querySelector('.signup-only');
  const nicknameInput = form.elements.nickname;
  const emailInput = form.elements.email;
  const passwordInput = form.elements.password;
  const submit = form.querySelector('.auth-submit');
  const forgot = form.querySelector('.auth-forgot');
  const resend = form.querySelector('.auth-resend');
  const message = form.querySelector('.auth-message');
  const switchMode = overlay.querySelector('.auth-switch');
  let registering = false;
  let recovering = false;
  let busy = false;
  let finished = false;
  let pendingEmail = '';
  const normalizeEmail = value => String(value || '').trim().toLowerCase();
  const pendingSignup = () => registering && !!pendingEmail && pendingEmail === normalizeEmail(emailInput.value);
  const confirmationMessage = 'Confira seu e-mail para concluir o cadastro. A confirmação é feita uma única vez.';
  const pendingMessage = 'Seu cadastro ainda está pendente. Conclua o cadastro para ativar sua conta.';

  const syncPendingControls = () => {
    const pending = pendingSignup();
    nicknameInput.required = registering && !pending && !recovering;
    passwordInput.required = recovering || !pending;
    resend.classList.toggle('hidden', !pending || recovering);
    resend.disabled = busy || !pending;
    switchMode.innerHTML = registering ? 'JÁ TEM CONTA? <u>ENTRAR</u>'
      : pendingEmail && pendingEmail === normalizeEmail(emailInput.value) ? 'CADASTRO PENDENTE? <u>CONCLUIR CADASTRO</u>'
      : 'AINDA NÃO TEM CONTA? <u>CADASTRE-SE</u>';
  };

  const setBusy = (value, text = '', error = !!text) => {
    busy = value;
    for (const control of [submit, switchMode, forgot, nicknameInput, emailInput, passwordInput]) {
      if (control) control.disabled = busy;
    }
    submit.textContent = busy ? 'AGUARDE...' : recovering ? 'SALVAR NOVA SENHA' : (registering ? 'PRONTO' : 'ENTRAR');
    message.textContent = text;
    message.classList.toggle('error', error);
    syncPendingControls();
  };

  const setMode = (signup) => {
    registering = signup;
    recovering = false;
    form.classList.toggle('registering', registering);
    title.textContent = registering ? 'CADASTRO' : 'LOGIN';
    nicknameRow.classList.toggle('hidden', !registering);
    emailInput.closest('label').classList.remove('hidden');
    emailInput.required = true;
    passwordInput.autocomplete = registering ? 'new-password' : 'current-password';
    passwordInput.minLength = 6;
    forgot.classList.toggle('hidden', registering);
    switchMode.classList.remove('hidden');
    syncPendingControls();
  };

  const finish = async (account) => {
    if (!account || account.confirmationRequired) return false;
    if (account.recoveryRequired) {
      recovering = true;
      title.textContent = 'NOVA SENHA';
      nicknameRow.classList.add('hidden'); nicknameInput.required = false;
      emailInput.closest('label').classList.add('hidden'); emailInput.required = false;
      passwordInput.autocomplete = 'new-password'; passwordInput.minLength = 8; passwordInput.value = '';
      forgot.classList.add('hidden'); resend.classList.add('hidden'); switchMode.classList.add('hidden');
      setBusy(false); overlay.classList.remove('auth-checking'); passwordInput.focus();
      return false;
    }
    await onAuthenticated(account);
    finished = true;
    overlay.classList.add('auth-done');
    setTimeout(() => overlay.remove(), 240);
    return true;
  };

  switchMode.addEventListener('click', () => {
    if (busy || recovering || finished) return;
    setMode(!registering);
    setBusy(false, pendingSignup() ? confirmationMessage : '', false);
  });

  emailInput.addEventListener('input', () => {
    if (busy || finished) return;
    setBusy(false, pendingSignup() ? confirmationMessage : '', false);
  });

  forgot.addEventListener('click', async () => {
    if (busy || registering || recovering || finished) return;
    if (!emailInput.checkValidity()) {
      setBusy(false, 'Digite seu e-mail para recuperar a senha.');
      emailInput.focus();
      return;
    }
    setBusy(true);
    try {
      await requestPasswordReset(emailInput.value);
      setBusy(false, 'Enviamos as instruções de recuperação para seu e-mail.', false);
    } catch (error) {
      setBusy(false, error.message || 'Não foi possível enviar a recuperação.');
    }
  });

  resend.addEventListener('click', async () => {
    if (busy || recovering || finished || !pendingSignup()) return;
    if (!emailInput.checkValidity()) {
      setBusy(false, 'Digite um e-mail válido para reenviar a confirmação.');
      emailInput.focus();
      return;
    }
    const email = pendingEmail;
    setBusy(true);
    resend.textContent = 'ENVIANDO...';
    try {
      await resendConfirmation(email);
      setBusy(false, 'Um novo e-mail de confirmação do cadastro foi enviado.', false);
    } catch (error) {
      setBusy(false, error.message || 'Não foi possível reenviar a confirmação.');
    } finally {
      resend.textContent = 'REENVIAR E-MAIL DE CONFIRMAÇÃO';
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy || finished) return;
    const mode = recovering ? 'recovery' : registering ? 'signup' : 'login';
    const email = normalizeEmail(emailInput.value);
    const password = passwordInput.value;
    const nickname = nicknameInput.value;
    if (mode === 'signup' && pendingSignup()) {
      setBusy(false, confirmationMessage, false);
      return;
    }
    setBusy(true);
    try {
      if (mode === 'recovery') {
        await updatePassword(password);
        try {
          const account = await restoreSession();
          if (!account || account.recoveryRequired) throw new Error('Sessão indisponível.');
          recovering = false;
          await finish(account);
        } catch {
          setMode(false);
          passwordInput.value = '';
          setBusy(false, 'Senha atualizada. Entre com seu e-mail e a nova senha para continuar.', false);
          emailInput.focus();
        }
        return;
      }
      const account = mode === 'signup'
        ? await signUp({ nickname, email, password })
        : await signIn(email, password);
      if (mode === 'signup' && account.confirmationRequired) {
        pendingEmail = email;
        setBusy(false, confirmationMessage, false);
        return;
      }
      await finish(account);
    } catch (error) {
      if (mode === 'login' && error.code === 'email_not_confirmed') {
        pendingEmail = email;
        setBusy(false, pendingMessage);
        return;
      }
      if (mode === 'recovery' && (error.status === 401 || error.status === 403)) {
        setMode(false);
        passwordInput.value = '';
        setBusy(false, 'Seu link de recuperação expirou. Use ESQUECI MINHA SENHA para solicitar outro.');
        emailInput.focus();
        return;
      }
      const errorMessage = error.message || 'Não foi possível entrar.';
      setBusy(false, errorMessage);
    }
  });

  setBusy(true);
  overlay.ready = restoreSession().then((account) => {
    if (account) return finish(account);
    setBusy(false);
    overlay.classList.remove('auth-checking');
  }).catch((error) => {
    setBusy(false, error.message || 'Não foi possível restaurar sua sessão. Entre novamente.');
    overlay.classList.remove('auth-checking');
  });

  return overlay;
}
