export function attachRackPanel(handlers) {
  if (window.parent === window || !new URLSearchParams(location.search).has('rack')) return null;
  try {
    const panel = window.parent.attachRackUploadPanel(window, handlers);
    if (!panel) return null;
    document.documentElement.classList.add('rack-upload-panel');

    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'secondary rack-confirm';
    confirm.hidden = true;
    document.getElementById('console-message').after(confirm);
    let displayed;
    let approved;
    const matchesHostname = name => {
      const state = panel.hostnameState(name);
      return state === 'selected' || (state === 'unknown' && approved === name.toUpperCase());
    };
    confirm.addEventListener('click', event => {
      if (!event.isTrusted || handlers.isBusy() || panel.hostnameState(displayed) !== 'unknown') return;
      approved = displayed.toUpperCase();
      handlers.refresh();
    });
    return {
      ...panel,
      matchesHostname,
      resetPrompt() {
        displayed = approved = undefined;
        confirm.hidden = true;
      },
      showHostname(name) {
        displayed = name;
        if (name && name.toUpperCase() !== approved) approved = undefined;
        const show = panel.hostnameState(name) === 'unknown' && !matchesHostname(name) && !handlers.isBusy();
        if (show) confirm.textContent = `Bevestig ${name} voor ${panel.name}`;
        confirm.hidden = !show;
        return matchesHostname(name);
      },
    };
  } catch {
    return null;
  }
}
