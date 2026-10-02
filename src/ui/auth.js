import { requestPasswordReset, resendConfirmation, restoreSession, signIn, signUp } from '../net/account.js';

export function openAuthGate(uiRoot, { onAuthenticated }) {
  const overlay = document.createElement('div');
  overlay.className = 'auth-overlay auth-checking';
  overlay.innerHTML = `
    <section class="auth-window" aria-label="Login Rinha Arena">
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

  const setBusy = (busy, text = '') => {
    submit.disabled = busy;
    submit.textContent = busy ? 'AGUARDE...' : (registering ? 'PRONTO' : 'ENTRAR');
    message.textContent = text;
    message.classList.toggle('error', !!text);
  };

  const finish = async (account) => {
    if (!account || account.confirmationRequired) return false;
    await onAuthenticated(account);
    overlay.classList.add('auth-done');
    setTimeout(() => overlay.remove(), 240);
    return true;
  };

  switchMode.addEventListener('click', () => {
    registering = !registering;
    form.classList.toggle('registering', registering);
    title.textContent = registering ? 'CADASTRO' : 'LOGIN';
    nicknameRow.classList.toggle('hidden', !registering);
    nicknameInput.required = registering;
    passwordInput.autocomplete = registering ? 'new-password' : 'current-password';
    forgot.classList.toggle('hidden', registering);
    resend.classList.add('hidden');
    switchMode.innerHTML = registering ? 'JÁ TEM CONTA? <u>ENTRAR</u>' : 'AINDA NÃO TEM CONTA? <u>CADASTRE-SE</u>';
    setBusy(false);
  });

  form.querySelector('.auth-forgot').addEventListener('click', async () => {
    if (!emailInput.checkValidity()) {
      message.textContent = 'Digite seu e-mail para recuperar a senha.';
      emailInput.focus();
      return;
    }
    setBusy(true);
    try {
      await requestPasswordReset(emailInput.value);
      message.classList.remove('error');
      message.textContent = 'Enviamos as instruções de recuperação para seu e-mail.';
      submit.disabled = false;
      submit.textContent = registering ? 'PRONTO' : 'ENTRAR';
    } catch (error) {
      setBusy(false, error.message || 'Não foi possível enviar a recuperação.');
    }
  });

  resend.addEventListener('click', async () => {
    if (!emailInput.checkValidity()) {
      message.textContent = 'Digite um e-mail válido para reenviar a confirmação.';
      message.classList.add('error');
      emailInput.focus();
      return;
    }
    resend.disabled = true;
    resend.textContent = 'ENVIANDO...';
    try {
      await resendConfirmation(emailInput.value);
      message.classList.remove('error');
      message.textContent = 'Um novo e-mail de confirmação foi enviado.';
    } catch (error) {
      message.classList.add('error');
      message.textContent = error.message || 'Não foi possível reenviar a confirmação.';
    } finally {
      resend.disabled = false;
      resend.textContent = 'REENVIAR E-MAIL DE CONFIRMAÇÃO';
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const account = registering
        ? await signUp({ nickname: nicknameInput.value, email: emailInput.value, password: passwordInput.value })
        : await signIn(emailInput.value, passwordInput.value);
      if (account.confirmationRequired) {
        message.classList.remove('error');
        message.textContent = 'Confira seu e-mail para confirmar a conta antes de entrar.';
        resend.classList.remove('hidden');
        submit.disabled = false;
        submit.textContent = 'PRONTO';
        return;
      }
      await finish(account);
    } catch (error) {
      const errorMessage = error.message || 'Não foi possível entrar.';
      setBusy(false, errorMessage);
      if (!registering && /confirm|confirmed|confirmation/i.test(errorMessage)) {
        resend.classList.remove('hidden');
      }
    }
  });

  setBusy(true);
  restoreSession().then((account) => {
    if (account) return finish(account);
    setBusy(false);
    overlay.classList.remove('auth-checking');
  }).catch(() => {
    setBusy(false);
    overlay.classList.remove('auth-checking');
  });

  return overlay;
}
