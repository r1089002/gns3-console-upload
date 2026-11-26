import { SERIAL_WRITES_ENABLED, SOURCE_ORIGINS } from './upload-settings.mjs?v=20261028-3';
import { SerialSession, serialErrorMessage } from './upload-serial.mjs?v=20261122-1';
import { ConsoleTranscript } from './upload-terminal.mjs?v=20261122-1';
import { PAN_INPUT_MAX_BYTES, PAN_PAGER_PROMPT, identifyPAN, panPrompt, panosTrain, preparePAN, preparePANConsole, stagePAN } from './pan-upload-core.mjs?v=20261126-2';

const $ = id => document.getElementById(id);
const consoleInput = $('console-input');
const consoleOutput = $('console-output');
const configInput = $('configInput');
const configFile = $('configFile');
const params = new URLSearchParams(location.search);
const target = params.get('device');
const cacheRequested = params.get('source') === 'cache';
const CACHE_TARGET_MODEL = 'PA-440';
const targetKnown = target === 'FW-NY' || target === 'FW-BRU';
const serialAvailable = SERIAL_WRITES_ENABLED && Boolean(navigator.serial) && isSecureContext;
const states = {
  closed: 'Niet verbonden', choosing: 'Poort kiezen', opening: 'Verbinden',
  open: 'Verbonden', closing: 'Poort vrijgeven', blocked: 'Poortstatus onbekend'
};
const loginPrompt = /^(?:[\w.-]+\s+)?(?:login|username):$/i;
const passwordPrompt = /^(?:enter\s+)?(?:(?:a\s+)?(?:old|new|current|confirm|re-enter)\s+)?password\s*:$/i;
const secretWords = /\b(?:password|secret|phash|community|key-string|pre-shared-key|authentication-key|privacy-key|private-key)\b/i;

class PANTranscript extends ConsoleTranscript {
  promptForLine(line) {
    const prompt = panPrompt(line);
    if (this.mode === 'upload' && (prompt?.user !== this.uploadIdentity?.user ||
      prompt?.hostname !== this.uploadIdentity?.hostname)) return null;
    return prompt;
  }

  observe(line) {
    if (!line && !this.truncated) return;
    this.prompt = line === this.sensitiveInput ? '' : this.promptForLine(line)?.text || '';
    this.login = loginPrompt.test(line);
    this.password = passwordPrompt.test(line);
    this.more = PAN_PAGER_PROMPT.test(line);
  }

  beginInput(value, options) {
    const keepUploadMask = this.mode === 'upload' && value === '';
    super.beginInput(value, options);
    if (keepUploadMask) this.mode = 'upload';
    else if (secretWords.test(value)) this.mode = 'secret';
    this.login = false;
  }

  beginUpload() {
    const identity = this.promptForLine(this.prompt);
    super.beginUpload();
    this.uploadIdentity = identity;
    this.login = false;
  }

  visibleLine(line, partial = false) {
    if (this.truncated) return this.mode === 'manual' ? '[Console-uitvoer ingekort]' : '';
    if (!line || line === this.sensitiveInput) return '';
    const prompt = this.promptForLine(line)?.text;
    if (this.mode === 'upload') return prompt || (/^(?:Entering configuration mode|\[edit\])$/.test(line) ? line : '');
    if (passwordPrompt.test(line)) return 'Password:';
    if (this.mode === 'secret') return prompt || '';
    if (partial && !prompt && !loginPrompt.test(line) && !PAN_PAGER_PROMPT.test(line)) return '';
    if (secretWords.test(line)) return '[Gevoelige console-inhoud afgeschermd]';
    return line;
  }
}

let session = null;
let consoleState = 'closed';
let transcript = new PANTranscript();
let writingManually = false;
let operation = null;
let checkedDevice = null;
let prepared = null;
let cachedSource = null;
let cancelCacheRequest = null;
let sourceRevision = 0;
let readingFile = false;
let leaving = false;

function status(message, phase = 'waiting', label = 'Wacht op console') {
  $('app').dataset.phase = phase;
  $('phase-badge').textContent = label;
  $('uploadStatus').textContent = message;
  $('uploadStatus').classList.toggle('error', phase === 'error' || phase === 'stopped');
}

function progress(count, total) {
  const percent = total ? Math.floor(count / total * 100) : 0;
  $('uploadProgress').value = percent;
  $('uploadValue').textContent = `${percent}%`;
}

function clearReview() {
  prepared = null;
  $('configPreview').textContent = '';
  $('configPreview').hidden = true;
  $('configCount').textContent = 'Nog geen opdrachten klaargezet.';
}

function showPrepared(commands) {
  prepared = commands;
  $('configCount').textContent = `${commands.length} ${commands.length === 1 ? 'opdracht' : 'opdrachten'} klaargezet.`;
  $('configPreview').textContent = commands.join('\n');
  $('configPreview').hidden = false;
  progress(0, commands.length);
}

function render() {
  const open = consoleState === 'open';
  const manual = open && !operation && !writingManually && !leaving;
  const prompt = panPrompt(transcript.prompt);
  const canCheck = manual && prompt?.mode === 'operational' && !transcript.more && !transcript.password;
  const matchingPrompt = checkedDevice?.hostname.toLowerCase() === prompt?.hostname.toLowerCase();
  const maskInput = transcript.password || (consoleInput.type === 'password' && consoleInput.value !== '');
  $('app').dataset.portState = consoleState;
  $('console-state').textContent = states[consoleState];
  $('console-mode').textContent = operation && open ? operation.label : open ? 'Handmatige invoer' : 'Inactief';
  $('console-connect').textContent = open ? 'Verbreken' : 'Verbinden';
  $('console-connect').disabled = leaving || !serialAvailable || operation !== null || writingManually ||
    (consoleState !== 'closed' && !open);
  $('baud').disabled = consoleState !== 'closed';
  $('console-prompt').textContent = maskInput ? 'Password:' : transcript.prompt || '—';
  consoleInput.type = maskInput ? 'password' : 'text';
  consoleInput.disabled = !manual || transcript.more;
  $('console-enter').disabled = consoleInput.disabled;
  $('console-interrupt').disabled = !manual;
  $('console-more').hidden = !manual || !transcript.more || transcript.mode === 'upload';
  $('checkDevice').hidden = cachedSource !== null;
  $('checkDevice').disabled = !canCheck;
  $('physicalDevice').textContent = checkedDevice
    ? `${checkedDevice.hostname} · ${checkedDevice.model} · PAN-OS ${checkedDevice.version} · Serienummer ${checkedDevice.serial}`
    : 'Fysieke firewall nog niet gecontroleerd.';
  configInput.disabled = operation !== null;
  $('chooseFile').disabled = operation !== null;
  $('prepareConfig').disabled = operation !== null || readingFile;
  $('upload').disabled = !targetKnown || !canCheck || !prepared || readingFile ||
    (!cachedSource && (!checkedDevice || !matchingPrompt));
  $('stop').hidden = operation === null;
  $('stop').textContent = operation?.label === 'Toestel controleren' ? 'Controle stoppen' : 'Upload stoppen';

  const step = operation?.label === 'Upload actief' || $('app').dataset.phase === 'done' ? 'upload' :
    !open ? 'connect' : cachedSource && canCheck && prepared ? 'upload' : !checkedDevice ? 'check' : !prepared ? 'prepare' : 'upload';
  for (const key of ['connect', 'check', 'prepare', 'upload']) {
    if (key === step) $(`step-${key}`).setAttribute('aria-current', 'step');
    else $(`step-${key}`).removeAttribute('aria-current');
  }

  const output = transcript.text;
  if (consoleOutput.textContent !== output) {
    const follow = consoleOutput.scrollHeight - consoleOutput.scrollTop - consoleOutput.clientHeight < 30;
    consoleOutput.textContent = output;
    if (follow) consoleOutput.scrollTop = consoleOutput.scrollHeight;
  }
}

function consoleMessage(message) {
  const element = $('console-message');
  if (element.textContent !== message) element.textContent = message;
}

function showPromptHint() {
  if (transcript.password) consoleMessage('Voer het wachtwoord van de fysieke firewall in.');
  else if (transcript.login) consoleMessage('Meld je aan op de fysieke firewall.');
  else if (transcript.more) consoleMessage(transcript.mode === 'upload'
    ? 'Gebruik Ctrl+C om terug te keren naar de prompt.'
    : 'Klik op Volgende pagina of onderbreek de uitvoer.');
  else if (panPrompt(transcript.prompt)?.mode === 'configuration') {
    consoleMessage('Je staat in de configuratiemodus. Beoordeel de candidate vóór je zelf commit. Gebruik exit om terug te keren voor een nieuwe toestelcontrole.');
  } else if (transcript.prompt && cachedSource && prepared) {
    consoleMessage('De operationele prompt is klaar. De identiteit en candidate worden bij de upload gecontroleerd.');
  } else if (transcript.prompt) consoleMessage(checkedDevice
    ? 'De fysieke identiteit is gecontroleerd. Bekijk de regels en de fysieke gegevens voor je uploadt.'
    : 'De operationele prompt is klaar. Klik op Toestel controleren.');
  else consoleMessage('Druk op Enter om de prompt op te vragen.');
}

function finishClose(owned, result, message) {
  if (session !== owned || leaving) return;
  consoleState = result.complete ? 'closed' : result.pending ? 'closing' : 'blocked';
  if (result.complete) session = null;
  const explanation = result.complete ? '' : result.pending
    ? ' De COM-poort wordt nog vrijgegeven.'
    : ' De COM-poort kon niet aantoonbaar worden gesloten. Controleer de kabel en sluit dit venster.';
  consoleMessage(message + explanation);
  render();
}

async function closeConsole(owned, message) {
  if (session !== owned || ['closing', 'blocked'].includes(consoleState)) return;
  consoleState = 'closing';
  checkedDevice = null;
  consoleInput.value = '';
  render();
  const result = await owned.close();
  finishClose(owned, result, message);
  if (result.pending) void owned.closed.then(late => finishClose(owned, late, message));
}

$('console-connect').onclick = async event => {
  if (!event.isTrusted || $('console-connect').disabled) return;
  if (consoleState === 'open') {
    await closeConsole(session, 'Consoleverbinding verbroken.');
    return;
  }

  const baudRate = Number($('baud').value);
  consoleState = 'choosing';
  consoleMessage('Kies de USB-consolepoort van je fysieke firewall.');
  render();
  let owned;
  try {
    const port = await navigator.serial.requestPort();
    if (leaving) return;
    transcript = new PANTranscript();
    owned = new SerialSession(port, {
      onData(value) {
        if (session !== owned || leaving || !['opening', 'open'].includes(consoleState)) return;
        transcript.feed(value);
        const prompt = panPrompt(transcript.prompt);
        if (checkedDevice && (transcript.login || transcript.password ||
          (prompt && checkedDevice.hostname.toLowerCase() !== prompt.hostname.toLowerCase()))) checkedDevice = null;
        if (consoleState === 'open' && !operation) showPromptHint();
        render();
      },
      onDisconnect(error) {
        if (session === owned && !leaving) void closeConsole(owned, serialErrorMessage(error));
      }
    });
    session = owned;
    consoleState = 'opening';
    consoleMessage('USB-console openen…');
    render();
    await owned.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    if (session !== owned || consoleState !== 'opening' || leaving) return;
    consoleState = 'open';
    showPromptHint();
    render();
    consoleInput.focus();
  } catch (error) {
    if (leaving) return;
    const message = serialErrorMessage(error);
    if (owned) await closeConsole(owned, message);
    else {
      consoleState = 'closed';
      consoleMessage(message);
      render();
    }
  }
};

async function writeManual(value, input = '', password = false) {
  if (consoleState !== 'open' || operation || writingManually || leaving || !session) return;
  const owned = session;
  writingManually = true;
  if (input !== '') checkedDevice = null;
  transcript.beginInput(input, { password });
  consoleInput.value = '';
  render();
  try {
    await owned.sendInput(value);
  } catch (error) {
    if (consoleState === 'open') await closeConsole(owned, serialErrorMessage(error));
  } finally {
    writingManually = false;
    if (!leaving && session === owned && consoleState === 'open') {
      if (transcript.prompt || transcript.password || transcript.more || transcript.login) showPromptHint();
      else consoleMessage('Wachten op antwoord van de fysieke console.');
    }
    render();
    if (!consoleInput.disabled) consoleInput.focus();
  }
}

function submitManual() {
  if (consoleInput.disabled) return;
  const input = consoleInput.value;
  void writeManual(input + '\r', input, consoleInput.type === 'password');
}

$('console-form').onsubmit = event => event.preventDefault();
$('console-enter').onclick = event => {
  if (event.isTrusted) submitManual();
};
$('console-more').onclick = event => {
  if (event.isTrusted && transcript.more) void writeManual(' ');
};
$('console-interrupt').onclick = event => {
  if (event.isTrusted) void writeManual('\x03');
};
consoleInput.onkeydown = event => {
  if (!event.isTrusted || event.isComposing) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    submitManual();
  } else if (event.ctrlKey && !event.altKey && !event.metaKey &&
    event.key.toLowerCase() === 'c' && consoleInput.selectionStart === consoleInput.selectionEnd) {
    event.preventDefault();
    void writeManual('\x03');
  }
};

configInput.oninput = () => {
  ++sourceRevision;
  configFile.value = '';
  readingFile = false;
  clearReview();
  render();
};

$('chooseFile').onclick = event => {
  if (event.isTrusted && !operation) configFile.click();
};

configFile.onchange = async () => {
  const file = configFile.files[0];
  if (!file || operation || leaving) return;
  const revision = ++sourceRevision;
  cachedSource = null;
  $('cacheSource').hidden = true;
  $('cacheSource').textContent = '';
  clearReview();
  configInput.value = '';
  readingFile = true;
  render();
  try {
    if (!/\.(?:txt|set)$/i.test(file.name)) throw new Error('Bestandstype');
    if (file.size > PAN_INPUT_MAX_BYTES) {
      $('configCount').textContent = `Het bestand mag maximaal ${PAN_INPUT_MAX_BYTES / (1024 * 1024)} MiB groot zijn.`;
      return;
    }
    const text = await file.text();
    if (!leaving && revision === sourceRevision) {
      configInput.value = text;
      $('configCount').textContent = 'Bestand geladen. Klik op Regels bekijken.';
    }
  } catch {
    if (!leaving && revision === sourceRevision) $('configCount').textContent = 'Kies een leesbaar .txt- of .set-bestand.';
  } finally {
    if (!leaving && revision === sourceRevision) {
      readingFile = false;
      configFile.value = '';
      render();
    }
  }
};

$('prepareConfig').onclick = event => {
  if (!event.isTrusted || $('prepareConfig').disabled || leaving) return;
  clearReview();
  try {
    showPrepared(preparePAN(configInput.value));
    if (targetKnown) status('Vergelijk de regels met de gekozen fysieke firewall.', 'ready', 'Regels klaargezet');
  } catch (error) {
    $('configCount').textContent = error?.code === 'PAN_INPUT' ? error.message : 'De opdrachten konden niet worden verwerkt.';
  }
  render();
};

async function runConsole(label, action) {
  const owned = session;
  const prompt = transcript.prompt;
  const controller = new AbortController();
  operation = { controller, label };
  transcript.beginUpload();
  consoleInput.value = '';
  consoleMessage('Handmatige invoer komt terug zodra deze consolebewerking klaar is.');
  render();
  try {
    const exchange = (command, options) => owned.exchange(command, options);
    await action(exchange, controller.signal, prompt);
  } finally {
    transcript.endUpload();
    operation = null;
    if (leaving) return;
    if (consoleState === 'open') showPromptHint();
    render();
    if (!consoleInput.disabled) consoleInput.focus();
  }
}

function operationError(error) {
  const message = typeof error?.code === 'string' && error.code.startsWith('PAN_')
    ? error.message : 'De consolebewerking is onderbroken.';
  if (error?.code === 'PAN_PAGER') return `${message} Gebruik Ctrl+C om terug te keren naar de prompt.`;
  return message;
}

$('checkDevice').onclick = event => {
  if (!event.isTrusted || $('checkDevice').disabled) return;
  checkedDevice = null;
  if (targetKnown) status('Fysieke firewall uitlezen…', 'checking', 'Toestel controleren');
  void runConsole('Toestel controleren', async (exchange, signal, prompt) => {
    try {
      await preparePANConsole(exchange, prompt, {signal});
      const identity = await identifyPAN(exchange, { signal });
      if (leaving || signal.aborted || consoleState !== 'open') return;
      checkedDevice = identity;
      if (targetKnown) status('Vergelijk de fysieke gegevens met het gekozen GNS3-toestel.', 'ready', 'Toestel gecontroleerd');
    } catch (error) {
      if (leaving || !targetKnown) return;
      if (signal.aborted) status('Toestelcontrole gestopt.', 'stopped', 'Gestopt');
      else status(operationError(error), 'error', 'Controle onderbroken');
    }
  });
};

$('upload').onclick = event => {
  if (!event.isTrusted || $('upload').disabled) return;
  const checkedBeforeUpload = checkedDevice;
  const requiredTrain = cachedSource?.train;
  const commands = prepared;
  let confirmed = 0;
  progress(0, commands.length);
  status('Console voorbereiden en fysieke firewall controleren…', 'uploading', 'Upload actief');
  void runConsole('Upload actief', async (exchange, signal, prompt) => {
    try {
      await preparePANConsole(exchange, prompt, {signal});
      const expectedDevice = checkedBeforeUpload ?? await identifyPAN(exchange, {signal});
      if (leaving || signal.aborted || consoleState !== 'open') return;
      checkedDevice = expectedDevice;
      const result = await stagePAN(commands, exchange, {
        expectedDevice, requiredTrain, requiredModel: requiredTrain ? CACHE_TARGET_MODEL : undefined, signal,
        onProgress(count, total) {
          if (leaving || signal.aborted) return;
          confirmed = count;
          progress(count, total);
          status(`${count} van ${total} opdrachten bevestigd.`, 'uploading', 'Upload actief');
        }
      });
      if (leaving) return;
      status(`${result.count} van ${commands.length} opdrachten in de candidate bevestigd. Controleer de wijzigingen en voer waar nodig zelf een commit uit.`,
        'done', 'Candidate bijgewerkt');
    } catch (error) {
      if (leaving) return;
      const message = signal.aborted ? 'Upload gestopt.' : operationError(error);
      const guidance = ['PAN_VERSION', 'PAN_MODEL'].includes(error?.code) ? '' :
        ' Controleer de candidate voordat je opnieuw begint.';
      status(`${message} ${confirmed} van ${commands.length} opdrachten bevestigd.${guidance}`,
        signal.aborted ? 'stopped' : 'error', signal.aborted ? 'Gestopt' : 'Upload onderbroken');
    }
  });
};

$('stop').onclick = event => {
  if (!event.isTrusted || !operation || !session) return;
  const owned = session;
  operation.controller.abort();
  owned.stop();
  void closeConsole(owned, 'Consolebewerking gestopt. De consoleverbinding is verbroken.');
};

function requestCacheSource() {
  const opener = window.opener;
  if (!opener) {
    status('Open Upload config bij de firewall in GNS3 om Configcache te laden.', 'error', 'Bron ontbreekt');
    return;
  }
  const random = crypto.getRandomValues(new Uint8Array(16));
  const job = Array.from(random, octet => octet.toString(16).padStart(2, '0')).join('');
  const dateFormat = new Intl.DateTimeFormat('nl-BE', {dateStyle:'medium', timeStyle:'short', timeZone:'Europe/Brussels'});
  const deadline = setTimeout(() => {
    cancel();
    if (!leaving && !sourceRevision) {
      status('Geen antwoord van GNS3. Open Upload config opnieuw.', 'error', 'Bron ontbreekt');
    }
  }, 30000);

  function cancel() {
    clearTimeout(deadline);
    window.removeEventListener('message', receive);
    cancelCacheRequest = null;
  }

  function receive(event) {
    const data = event.data;
    if (leaving || event.source !== opener || !SOURCE_ORIGINS.includes(event.origin) ||
        data?.version !== 1 || data.device !== target || data.job !== job ||
        !['panos-cache-source', 'panos-cache-error'].includes(data.type)) return;
    cancel();
    if (sourceRevision) return;
    if (data.type === 'panos-cache-error') {
      const messages = {
        cache_updating: 'Configcache wordt bijgewerkt. Open Upload config opnieuw zodra de nieuwe kopie beschikbaar is.',
        cache_set_unavailable: 'De cache heeft nog geen USB-config voor deze kopie. Controleer of de virtuele firewall online is en de console vrij is.',
        cache_empty: 'Configcache heeft nog geen opgeslagen configuratie voor deze firewall.',
        access_denied: 'Meld je opnieuw aan bij GNS3 om de configuratie te laden.',
        invalid_token: 'Meld je opnieuw aan bij GNS3 om de configuratie te laden.',
      };
      const message = Object.hasOwn(messages, data.code) ? messages[data.code] :
        'GNS3 kon geen geschikte opgeslagen configuratie klaarzetten.';
      status(message, 'error', 'Bron ontbreekt');
      return;
    }
    try {
      const train = panosTrain(data.panosVersion);
      const isoDate = typeof data.capturedAt === 'string' &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(data.capturedAt);
      const captured = isoDate ? Date.parse(data.capturedAt) : NaN;
      if (!train || !Number.isFinite(captured) || !Number.isSafeInteger(data.skipped) || data.skipped < 0) {
        throw Error('Ongeldige bronmetadata');
      }
      const commands = preparePAN(data.config);
      cachedSource = {train};
      configInput.value = commands.join('\n');
      $('cacheSource').textContent = `Configcache van ${dateFormat.format(captured)} · PAN-OS ${data.panosVersion}` +
        (data.skipped ? ` · ${data.skipped} onderdelen overgeslagen` : '') + ` · ${CACHE_TARGET_MODEL}-profiel`;
      $('cacheSource').hidden = false;
      showPrepared(commands);
      status('Bekijk de klaargezette regels. Meld je aan op de fysieke firewall en klik op Naar candidate uploaden.',
        'ready', 'Regels klaargezet');
    } catch {
      status('GNS3 gaf geen geldige PAN-OS-verzendlijst door.', 'error', 'Bron geweigerd');
    }
    if (consoleState === 'open' && !operation) showPromptHint();
    render();
  }

  cancelCacheRequest = cancel;
  window.addEventListener('message', receive);
  status('De opgeslagen configuratie wordt opgehaald uit GNS3.', 'waiting', 'Configcache ophalen');
  for (const origin of SOURCE_ORIGINS) {
    opener.postMessage({version:1, type:'panos-cache-ready', device:target, job}, origin);
  }
}

window.addEventListener('pagehide', () => {
  leaving = true;
  cancelCacheRequest?.();
  operation?.controller.abort();
  session?.stop();
  checkedDevice = null;
  cachedSource = null;
  clearReview();
  configInput.value = '';
  configFile.value = '';
  consoleInput.value = '';
  consoleOutput.textContent = '';
  transcript = new PANTranscript();
});
window.addEventListener('pageshow', event => {
  if (event.persisted) location.reload();
});

if (targetKnown) {
  $('targetDevice').textContent = target;
  if (cacheRequested) requestCacheSource();
} else status('Open Upload config bij FW-NY of FW-BRU in GNS3.', 'error', 'Kies een firewall');
if (!serialAvailable) consoleMessage('Gebruik Chrome of Edge via HTTPS om een USB-console te openen.');
render();
