// Shared game dialogs for short messages and protected-room passwords.
let dialogCount = 0;

function openDialog(root, { title, message, password = false }) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const id = `arena-dialog-${++dialogCount}`;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay arena-dialog-overlay';
    const window = document.createElement('form');
    window.className = 'modal-window arena-dialog-window';
    window.setAttribute('role', 'dialog');
    window.setAttribute('aria-modal', 'true');
    window.setAttribute('aria-labelledby', `${id}-title`);
    window.setAttribute('aria-describedby', `${id}-message`);
    const header = document.createElement('div');
    header.className = 'modal-header';
    const heading = document.createElement('div');
    const kicker = document.createElement('span');
    kicker.className = 'arena-dialog-kicker';
    kicker.textContent = 'RINHA ARENA';
    const titleNode = document.createElement('div');
    titleNode.className = 'modal-title';
    titleNode.id = `${id}-title`;
    titleNode.textContent = title;
    heading.append(kicker, titleNode);
    const closeButton = document.createElement('button');
    closeButton.className = 'modal-close';
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Fechar');
    closeButton.textContent = '✕';
    header.append(heading, closeButton);

    const body = document.createElement('div');
    body.className = 'modal-body';
    const messageNode = document.createElement('p');
    messageNode.className = 'arena-dialog-message';
    messageNode.id = `${id}-message`;
    messageNode.textContent = message;
    body.appendChild(messageNode);
    let input;
    if (password) {
      const field = document.createElement('label');
      field.className = 'arena-dialog-field';
      const label = document.createElement('span');
      label.textContent = 'SENHA DA SALA';
      input = document.createElement('input');
      input.className = 'arena-dialog-input';
      input.type = 'password';
      input.name = 'room-password';
      input.autocomplete = 'off';
      input.placeholder = 'Digite a senha';
      field.append(label, input);
      body.appendChild(field);
    }

    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    let cancelButton;
    if (password) {
      cancelButton = document.createElement('button');
      cancelButton.className = 'modal-btn modal-btn-secondary';
      cancelButton.type = 'button';
      cancelButton.textContent = 'CANCELAR';
      footer.appendChild(cancelButton);
    }
    const submitButton = document.createElement('button');
    submitButton.className = 'modal-btn modal-btn-primary';
    submitButton.type = 'submit';
    submitButton.textContent = password ? 'ENTRAR' : 'ENTENDI';
    footer.appendChild(submitButton);
    window.append(header, body, footer);
    overlay.appendChild(window);

    let settled = false;
    const close = (value = null) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
        previousFocus.focus({ preventScroll: true });
      }
      resolve(value);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      } else if (event.key === 'Tab') {
        const focusable = [closeButton, input, cancelButton, submitButton].filter(Boolean);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    closeButton.addEventListener('click', () => close());
    cancelButton?.addEventListener('click', () => close());
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    window.addEventListener('submit', (event) => {
      event.preventDefault();
      close(password ? input.value : true);
    });
    document.addEventListener('keydown', onKeyDown, true);
    root.appendChild(overlay);
    (input || submitButton).focus({ preventScroll: true });
  });
}

export function promptRoomPassword(root, roomName) {
  return openDialog(root, {
    title: 'SALA PROTEGIDA',
    message: `Digite a senha para entrar na sala “${roomName}”.`,
    password: true,
  });
}

export function showMessageDialog(root, { title = 'AVISO', message }) {
  return openDialog(root, { title, message });
}
