import { requestPasswordReset, restoreSession, signIn, signUp } from '../net/account.js';

export function openAuthGate(uiRoot, { onAuthenticated }) {
  const overlay = document.createElement('div');
  overlay.className = 'auth-overlay';
  overlay.innerHTML = `
    <section class="auth-window" aria-label="Login Rinha Arena">
      <div class="auth-art" aria-hidden="true"></div>
      <div class="auth-panel">
        <form class="auth-form">
          <h1>LOGIN</h1>
          <label class="signup-only hidden">NICKNAME<input name="nickname" maxlength="12" autocomplete="nickname" /></label>
          <label>E-MAIL<input name="email" type="email" autocomplete="email" required /></label>
          <label>SENHA<input name="password" type="password" minlength="6" autocomplete="current-password" required /></label>
          <div class="auth-actions"><button class="auth-forgot" type="button">ESQUECI MINHA SENHA</button><button class="auth-submit" type="submit">ENTRAR</button></div>
          <p class="auth-message" role="status"></p>
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
        submit.disabled = false;
        submit.textContent = 'PRONTO';
        return;
      }
      await finish(account);
    } catch (error) {
      setBusy(false, error.message || 'Não foi possível entrar.');
    }
  });

  setBusy(true);
  restoreSession().then((account) => {
    if (account) return finish(account);
    setBusy(false);
  }).catch(() => setBusy(false));

  return overlay;
}
