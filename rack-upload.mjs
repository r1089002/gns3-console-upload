import { SOURCE_ORIGINS } from './upload-settings.mjs?v=20261028-3';
import { SerialSession } from './upload-serial.mjs?v=20261126-1';

const $ = id => document.getElementById(id);
const rackStatus = $('rack-status');
const previous = $('use-previous');
const token = /^[a-f0-9]{32}$/;
const deviceId = /^[a-f0-9-]{36}$/;
const hostname = /^[a-z0-9][a-z0-9.-]{0,79}$/i;
const normalize = name => name.toUpperCase() === 'R-CHI' ? 'R-CHI1' : name.toUpperCase();
const errors = {
  cache_updating:'Configcache haalt een nieuwere kopie op. Klik opnieuw op het toestel om het nog eens te proberen.',
  cache_set_unavailable:'Configcache heeft voor dit toestel nog geen USB-config beschikbaar.',
  cache_empty:'Configcache heeft voor dit toestel nog geen opgeslagen configuratie.',
  unsupported_node:'Configcache herkent dit brontoestel momenteel niet. Kies een ander toestel of probeer opnieuw.',
  access_denied:'Meld je opnieuw aan bij GNS3 om de config op te halen.',
  invalid_token:'Meld je opnieuw aan bij GNS3 om de config op te halen.',
  timeout:'GNS3 antwoordde niet op tijd. Klik opnieuw op het toestel.',
};

let origin, ticket, current, assetTimer, requestTimer, usb, closing = false;
const devices = new Map();
const buttons = new Map();

function rackIsValid(rack) {
  if (!rack || !Number.isInteger(rack.width) || !Number.isInteger(rack.height) ||
      rack.width < 1 || rack.width > 5000 || rack.height < 1 || rack.height > 5000 ||
      !Number.isInteger(rack.visibleHeight) || rack.visibleHeight < 1 || rack.visibleHeight > rack.height ||
      typeof rack.image !== 'string' || rack.image.length > 2500000 ||
      !/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/=]+$/.test(rack.image) ||
      !Array.isArray(rack.entries) || rack.entries.length < 1 || rack.entries.length > 30) return false;
  const ids = new Set();
  for (const entry of rack.entries) {
    if (!entry || !deviceId.test(entry.id) || ids.has(entry.id) || !hostname.test(entry.name) ||
        ![null, 'cisco', 'panos'].includes(entry.kind) ||
        ![entry.x, entry.y, entry.width, entry.height].every(Number.isFinite) ||
        entry.x < 0 || entry.y < 0 || entry.width < 1 || entry.height < 1 ||
        entry.x + entry.width > rack.width || entry.y + entry.height > rack.visibleHeight) return false;
    ids.add(entry.id);
  }
  return true;
}

function portOpen() {
  return usb && usb.session.opened && usb.session.writer && !usb.session.closing;
}

function canSelect() {
  return !closing && !current?.handlers?.isBusy() && !usb?.session.busy;
}

function updateButtons() {
  const enabled = canSelect();
  for (const [id, button] of buttons) {
    button.disabled = !enabled;
    button.setAttribute('aria-pressed', String(id === current?.entry.id));
  }
  previous.disabled = !enabled;
}

function renderRack(rack) {
  $('rack-picture').style.setProperty('--rack-visible-ratio', rack.width + ' / ' + rack.visibleHeight);
  $('rack-image').src = rack.image;
  for (const entry of rack.entries) {
    if (!entry.kind) continue;
    devices.set(entry.id, entry);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'rack-device';
    button.dataset.device = entry.id;
    button.setAttribute('aria-label', entry.name);
    button.title = entry.name;
    button.style.setProperty('--rack-x', `${100 * entry.x / rack.width}%`);
    button.style.setProperty('--rack-y', `${100 * entry.y / rack.height}%`);
    button.style.setProperty('--rack-width', `${100 * entry.width / rack.width}%`);
    button.style.setProperty('--rack-height', `${100 * entry.height / rack.height}%`);
    button.addEventListener('click', event => { if (event.isTrusted) select(entry); });
    buttons.set(entry.id, button);
    $('rack-devices').append(button);
  }
  $('rack-picture').hidden = false;
}

function detachPanel() {
  if (!current) return;
  current.observer?.disconnect();
  if (usb) {
    usb.session.onData = null;
    usb.session.onDisconnect = null;
  }
  const frame = current.frame;
  current = null;
  frame.remove();
}

function deliver(selection) {
  if (selection !== current || !selection.handlers || !selection.reply) return;
  const reply = selection.reply;
  selection.reply = null;
  selection.handlers.receive(reply);
}

function finishSelection(selection, reply) {
  if (selection !== current || !selection.pending) return;
  clearTimeout(requestTimer);
  selection.pending = false;
  if (reply.error) {
    const message = Object.hasOwn(errors, reply.error)
      ? errors[reply.error] : 'GNS3 kon geen bruikbare config ophalen. Klik opnieuw op het toestel.';
    rackStatus.textContent = message;
    selection.reply = {error:message};
    const date = Date.parse(reply.previousAt);
    if (selection.entry.kind === 'cisco' && reply.error === 'cache_updating' && Number.isFinite(date)) {
      const time = new Intl.DateTimeFormat('nl-BE', {dateStyle:'short', timeStyle:'short', timeZone:'Europe/Brussels'}).format(date);
      rackStatus.textContent = `Configcache wordt bijgewerkt. De vorige kopie is van ${time}.`;
      previous.hidden = false;
    }
  } else {
    rackStatus.textContent = `${selection.entry.name} geselecteerd`;
    selection.reply = {snapshot:reply.snapshot};
  }
  deliver(selection);
}

function select(entry, allowPrevious = false) {
  if (!canSelect() || (current?.entry === entry && current.pending)) return;
  clearTimeout(requestTimer);
  detachPanel();
  previous.hidden = true;
  rackStatus.textContent = `Config ophalen voor ${entry.name}…`;

  const url = new URL(entry.kind === 'panos' ? './palo-upload.html' : './upload.html', location.href);
  url.searchParams.set('rack', '1');
  if (entry.kind === 'panos') url.searchParams.set('device', entry.name);
  const frame = document.createElement('iframe');
  frame.title = `Upload config voor ${entry.name}`;
  frame.src = url.href;
  const request = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  const selection = current = {entry, frame, request, pending:true};
  $('rack-panel').append(frame);
  updateButtons();
  if (window.matchMedia('(min-width: 621px)').matches) window.scrollTo(0, 0);

  requestTimer = setTimeout(() => finishSelection(selection, {error:'timeout'}), 30000);
  window.opener.postMessage({
    version:1, type:'rack-upload-select', ticket, request, device:entry.id, allowPrevious,
  }, origin);
}

window.attachRackUploadPanel = (frameWindow, handlers) => {
  const selection = current;
  if (!selection || selection.frame.contentWindow !== frameWindow || selection.handlers) return null;
  selection.handlers = handlers;
  const app = frameWindow.document.querySelector('main');
  selection.observer = new ResizeObserver(() => {
    selection.frame.style.height = Math.ceil(app.getBoundingClientRect().height) + 'px';
  });
  selection.observer.observe(app);
  return {
    name:selection.entry.name,
    ready() { deliver(selection); },
    update: updateButtons,
    closeWorkspace() { if (selection === current) window.close(); },
    requestPort() {
      if (selection !== current || usb) throw Error('De COM-poort is al in gebruik.');
      return navigator.serial.requestPort();
    },
    createSession(port, baudRate, callbacks) {
      if (selection !== current || usb) throw Error('De COM-poort is al in gebruik.');
      const session = new SerialSession(port, callbacks);
      usb = {session, baudRate};
      void session.closed.then(result => {
        if (usb?.session === session && result.complete) usb = null;
        updateButtons();
      });
      return session;
    },
    resume(callbacks) {
      if (selection !== current || !portOpen()) return null;
      Object.assign(usb.session, callbacks);
      return usb;
    },
    hostnameState(name) {
      if (selection !== current || typeof name !== 'string' || !hostname.test(name)) return 'missing';
      const actual = normalize(name);
      if (actual === normalize(selection.entry.name)) return 'selected';
      return [...devices.values()].some(entry => normalize(entry.name) === actual) ? 'other' : 'unknown';
    },
  };
};

previous.addEventListener('click', event => {
  if (event.isTrusted && current && !previous.hidden) select(current.entry, true);
});

window.addEventListener('message', event => {
  const data = event.data;
  if (closing || event.source !== window.opener || !SOURCE_ORIGINS.includes(event.origin) || data?.version !== 1) return;
  if (!ticket && data.type === 'rack-upload-unavailable') {
    clearTimeout(assetTimer);
    rackStatus.textContent = 'GNS3 kon het rack niet laden. Open Upload config opnieuw vanuit 24Fa.';
    return;
  }
  if (!ticket && data.type === 'rack-upload-session' && token.test(data.ticket) && rackIsValid(data.rack)) {
    if (!data.rack.entries.some(entry => entry.id === data.initial && entry.kind)) return;
    clearTimeout(assetTimer);
    origin = event.origin;
    ticket = data.ticket;
    renderRack(data.rack);
    select(devices.get(data.initial));
  } else if (ticket && event.origin === origin && data.type === 'rack-upload-source' && data.ticket === ticket &&
      current?.request === data.request && current.entry.id === data.device) {
    finishSelection(current, data);
  }
});

window.addEventListener('pagehide', () => {
  closing = true;
  clearTimeout(assetTimer);
  clearTimeout(requestTimer);
  usb?.session.stop();
  detachPanel();
  if (ticket) window.opener?.postMessage({version:1,type:'rack-upload-close',ticket}, origin);
});

window.addEventListener('pageshow', event => {
  if (event.persisted) location.reload();
});

if (window.opener && !window.opener.closed) {
  rackStatus.textContent = 'Rack ophalen uit GNS3…';
  assetTimer = setTimeout(() => {
    rackStatus.textContent = 'GNS3 antwoordt niet. Open Upload config opnieuw vanuit 24Fa.';
  }, 15000);
  for (const allowed of SOURCE_ORIGINS) {
    window.opener.postMessage({version:1,type:'rack-upload-ready'}, allowed);
  }
} else {
  rackStatus.textContent = 'Open Upload config bij een toestel in Project 2026 - 24Fa.';
}
