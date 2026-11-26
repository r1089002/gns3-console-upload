export const PAN_INPUT_MAX_BYTES = 2 * 1024 * 1024;
export const PAN_PAGER_PROMPT = /^\u0007*(?:--More--|\(END\)|lines \d+-\d+)[ \t]*$/i;

// PAN-OS 11.2 configuration roots for a firewall, including multi-vsys output.
const configRoots = new Set([
  'address', 'address-group', 'application', 'application-filter', 'application-group', 'application-tag',
  'authentication-object', 'captive-portal', 'cloud-identity-engine', 'device-object', 'deviceconfig',
  'disable-inspect', 'display-name', 'dns-proxy', 'dynamic-user-group', 'email-scheduler', 'external-list',
  'global-protect', 'group-mapping', 'import', 'iptag-include-exclude-list', 'ipuser-include-exclude-list',
  'log-settings', 'mgt-config', 'network', 'pdf-summary-report', 'profile-group', 'profiles',
  'redistribution-agent', 'redistribution-collector', 'region', 'report-group', 'reports', 'route',
  'rulebase', 'schedule', 'sdwan-interface-profile', 'service', 'service-group', 'setting', 'shared', 'tag',
  'threats', 'ts-agent', 'url-admin-override', 'url-content-types', 'user-context-segment', 'user-id-collector',
  'user-id-ssl-auth', 'vm-info-source', 'vsys', 'x-authenticated-user', 'zone',
]);
const operationalBranches = {
  application: new Set([
    'dump-unknown', 'cache', 'supernode', 'heuristics', 'use-cache-for-identification', 'use-simple-appsigs',
    'use-appid-cache-ssl-sni', 'notify-user', 'dump', 'traceroute',
  ]),
  'global-protect': new Set(['arg-maxlen', 'satellite-serialnumberip-auth', 'global-protect-portal', 'redirect']),
};
const unsafeInput = /[\p{C}\p{Zl}\p{Zp}]|[^\S ]/u;
const placeholder = /<[^<>]+>|\$\{|\{\{|\*{3,}|\b(?:masked|redacted|placeholder|change[-_]?me|replace[-_]?me|todo)\b/i;
const interactivePassword = /^set +mgt-config +users +(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^ ]+) +password(?: |$)/;
const promptPattern = /^([\w.@-]+)@([\w.-]+)(?:\([\w-]+\))?([>#])$/;

function panError(code, message) {
  return Object.assign(new Error(message), {code});
}

function inputError(line) {
  return panError('PAN_INPUT', `Regel ${line} bevat geen ondersteunde, volledig ingevulde PAN-OS-set-opdracht.`);
}

function checkInputSize(text) {
  if (text.length > PAN_INPUT_MAX_BYTES || new TextEncoder().encode(text).byteLength > PAN_INPUT_MAX_BYTES) {
    throw panError('PAN_INPUT', 'De PAN-OS-invoer is groter dan 2 MiB.');
  }
}

function validArguments(command) {
  let quote = '';
  let escaped = false;
  for (const character of command) {
    // The serial CLI interprets a question mark as help in interactive mode.
    if (character === '?' || (!quote && ';|<>#'.includes(character))) return false;
    if (escaped) {
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === quote) {
      quote = '';
    } else if (!quote && (character === '"' || character === "'")) {
      quote = character;
    }
  }
  return !quote && !escaped;
}

function checkedCommand(line, number) {
  if (typeof line !== 'string' || unsafeInput.test(line)) throw inputError(number);
  const command = line.trim();
  const path = /^set +([a-z][a-z0-9-]*) +(\S+)/.exec(command);
  if (!path || !configRoots.has(path[1]) || operationalBranches[path[1]]?.has(path[2]) ||
      placeholder.test(command) || interactivePassword.test(command) || !validArguments(command)) throw inputError(number);
  return command;
}

export function preparePAN(text) {
  if (typeof text !== 'string') throw panError('PAN_INPUT', 'Plak de voorbereide PAN-OS-set-opdrachten als tekst.');
  checkInputSize(text);
  const commands = [];
  const lines = text.replace(/^\ufeff/, '').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (unsafeInput.test(line)) throw inputError(index + 1);
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) commands.push(checkedCommand(trimmed, index + 1));
  }
  if (!commands.length) throw panError('PAN_INPUT', 'Voeg minstens één PAN-OS-set-opdracht toe.');
  return commands;
}

function responseLines(output) {
  if (typeof output !== 'string') return [];
  return output.replace(/\u001b\[[0-9;]*[Km]/g, '').split(/\r\n?|\n/)
    .map(line => line.replace(/^[ \t]+|[ \t]+$/g, '')).filter(Boolean);
}

function parsePrompt(line) {
  const text = line?.replace(/^\u0007+/, '') ?? '';
  const match = promptPattern.exec(text);
  if (!match) return null;
  return {mode:match[3] === '>' ? 'operational' : 'configuration', hostname:match[2], user:match[1], text};
}

export function panPrompt(output) {
  return parsePrompt(responseLines(output).at(-1));
}

function acceptPrompt(output) {
  const tail = responseLines(output).at(-1) ?? '';
  return Boolean(parsePrompt(tail)) || PAN_PAGER_PROMPT.test(tail) ||
    /^(?:[\w.-]+\s+login|login|username|(?:enter\s+)?(?:old\s+|new\s+|confirm\s+|retype\s+)?password):$/i.test(tail);
}

function checkAbort(signal) {
  if (signal?.aborted) throw panError('PAN_ABORTED', 'PAN-OS-overdracht afgebroken.');
}

async function readCommand(exchange, command, signal, step) {
  checkAbort(signal);
  let output;
  try {
    output = await exchange(command, {acceptAdditionalPrompt:acceptPrompt, signal});
  } catch (error) {
    checkAbort(signal);
    const problem = error?.code === 'SERIAL_TIMEOUT' ? 'Er kwam geen tijdig antwoord' : 'De seriële communicatie werd onderbroken';
    throw panError('PAN_EXCHANGE', `${problem} tijdens ${step}.`);
  }
  checkAbort(signal);
  const lines = responseLines(output);
  const tail = lines.pop() ?? '';
  if (PAN_PAGER_PROMPT.test(tail)) {
    throw panError('PAN_PAGER', `De firewall wacht tijdens ${step} op de volgende pagina.`);
  }
  return {prompt:parsePrompt(tail), lines};
}

function commandBody(response, command, before) {
  const echo = response.lines[0];
  if (echo === command || (before && echo?.startsWith(before.text) && echo.slice(before.text.length).replace(/^[ \t]+/, '') === command)) {
    return response.lines.slice(1);
  }
  return null;
}

export async function preparePANConsole(exchange, promptText, {signal} = {}) {
  const prompt = panPrompt(promptText);
  if (prompt?.mode !== 'operational') {
    throw panError('PAN_PROMPT', 'Open de operationele PAN-OS-prompt (>) en probeer opnieuw.');
  }
  for (const command of ['set cli pager off', 'set cli terminal height 500', 'set cli terminal width 500']) {
    const response = await readCommand(exchange, command, signal, 'de terminalvoorbereiding');
    if (response.prompt?.text !== prompt.text || commandBody(response, command, prompt)?.length !== 0) {
      throw panError('PAN_TERMINAL', `De bevestiging van “${command}” ontbreekt. Controleer de operationele prompt (>).`);
    }
  }
}

const identityFields = {model:'model', version:'sw-version', hostname:'hostname', serial:'serial'};

function identityError() {
  return panError('PAN_IDENTITY', 'De identiteit van de aangesloten Palo Alto-firewall kon niet worden bevestigd.');
}

function validIdentity(device) {
  return typeof device?.model === 'string' && /^(?:PA-VM|PA-\d[A-Z0-9-]*)$/i.test(device.model) &&
    typeof device.version === 'string' && /^\d+\.\d+\.\d+(?:-[a-z0-9]+)*$/i.test(device.version) &&
    typeof device.hostname === 'string' && /^[\w.-]+$/.test(device.hostname) &&
    typeof device.serial === 'string' && /^[a-z0-9-]{3,64}$/i.test(device.serial) && /[1-9]/.test(device.serial);
}

async function inspectPAN(exchange, signal) {
  const command = 'show system info';
  const response = await readCommand(exchange, command, signal, 'de toestelcontrole');
  if (response.prompt?.mode !== 'operational') {
    throw panError('PAN_PROMPT', 'Open de operationele PAN-OS-prompt (>) en controleer de firewall opnieuw.');
  }
  const info = commandBody(response, command, response.prompt);
  if (!info) throw identityError();
  const fields = new Map();
  for (const line of info) {
    const match = /^([a-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!match || fields.has(match[1]) || /^(?:error|warning|failure)$/.test(match[1])) throw identityError();
    fields.set(match[1], match[2]);
  }
  const device = Object.fromEntries(Object.entries(identityFields).map(([key, field]) => [key, fields.get(field)]));
  if (!validIdentity(device) || device.hostname.toLowerCase() !== response.prompt.hostname.toLowerCase()) throw identityError();
  return {device, prompt:response.prompt};
}

export async function identifyPAN(exchange, {signal} = {}) {
  return (await inspectPAN(exchange, signal)).device;
}

export function panosTrain(version) {
  if (typeof version !== 'string' || version.length > 32) return null;
  return /^(\d{1,3}\.\d{1,3})(?:\.\d+(?:-[a-z0-9]+)*)?$/i.exec(version)?.[1] ?? null;
}

export async function stagePAN(commands, exchange, {
  expectedDevice, requiredTrain, requiredModel, signal, onProgress = () => {},
} = {}) {
  if (!Array.isArray(commands) || !commands.length) throw panError('PAN_INPUT', 'Voeg minstens één PAN-OS-set-opdracht toe.');
  const queue = Array.from(commands, (command, index) => checkedCommand(command, index + 1));
  checkInputSize(queue.join('\n'));
  const expected = {...expectedDevice};
  if (!validIdentity(expected)) throw panError('PAN_IDENTITY', 'Controleer eerst de aangesloten Palo Alto-firewall.');

  const {device, prompt} = await inspectPAN(exchange, signal);
  if (Object.keys(identityFields).some(field => device[field] !== expected[field])) {
    throw panError('PAN_IDENTITY', 'De aangesloten firewall komt niet meer overeen met de gecontroleerde firewall.');
  }

  if (requiredTrain !== undefined && (!requiredTrain || panosTrain(device.version) !== requiredTrain)) {
    throw panError('PAN_VERSION', `De bron gebruikt PAN-OS ${requiredTrain}. De fysieke firewall draait PAN-OS ${device.version}. Uploaden vereist dezelfde PAN-OS-reeks.`);
  }
  if (requiredModel !== undefined && device.model.toUpperCase() !== requiredModel) {
    throw panError('PAN_MODEL', `Het Configcache-profiel vereist een ${requiredModel}. De aangesloten firewall is een ${device.model}.`);
  }

  const diffCommand = 'show config diff';
  const diff = await readCommand(exchange, diffCommand, signal, 'de kandidaatcontrole');
  const candidate = commandBody(diff, diffCommand, prompt);
  if (diff.prompt?.text !== prompt.text || !candidate ||
      (candidate.length !== 0 && candidate.join('\n') !== 'No configuration changes.')) {
    throw panError('PAN_CANDIDATE', 'Een lege PAN-OS-kandidaatconfiguratie kon niet worden bevestigd. Controleer de kandidaat in de console.');
  }

  const configurationPrompt = `${prompt.text.slice(0, -1)}#`;
  const configure = await readCommand(exchange, 'configure', signal, 'het openen van de configuratiemodus');
  const entered = commandBody(configure, 'configure', prompt)?.join('\n');
  if (configure.prompt?.text !== configurationPrompt ||
      (entered !== 'Entering configuration mode\n[edit]' && entered !== '[edit]')) {
    throw panError('PAN_CONFIGURE', 'De hoofdmodus voor PAN-OS-configuratie kon niet worden bevestigd.');
  }

  for (const [index, command] of queue.entries()) {
    const response = await readCommand(exchange, command, signal, `opdracht ${index + 1} van ${queue.length}`);
    if (response.prompt?.text !== configurationPrompt || commandBody(response, command, configure.prompt)?.join('\n') !== '[edit]') {
      throw panError('PAN_COMMAND', `PAN-OS-opdracht ${index + 1} van ${queue.length} werd niet bevestigd. Controleer de kandidaat in de console.`);
    }
    onProgress(index + 1, queue.length);
    checkAbort(signal);
  }
  return {count:queue.length};
}
