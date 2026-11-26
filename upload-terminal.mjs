const host = '[A-Za-z0-9_.-]{1,64}';
const prompt = new RegExp('^(' + host + ')(?:\\([A-Za-z0-9/-]{1,35}\\))?[>#]$');
const execPrompt = new RegExp('^' + host + '#$');
const safeEcho = new RegExp('^(' + host + ')(?:\\([A-Za-z0-9/-]{1,35}\\))?#\\s*(?:configure terminal|end|no ip routing|write memory|copy running-config startup-config)$', 'i');
const secretWords = /\b(?:password|secret|community|key-string|pre-shared-key|authentication-key|privacy-key)\b/i;
const passwordPrompt = /^(?:(?:old|new|confirm|re-enter)\s+)?password:\s*$/i;
const confirmation = /(?:\[(?:confirm|yes\/no|y\/n)\]\s*[:?]?|^Destination filename \[[^\]]+\]\?)$/i;
const maxLineLength = 2048;

function withoutControlSequences(value) {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** Match the IOS redraws and confirm the device line is empty again. */
export function iosCompletion(reply, prompt, input) {
  const redraws = reply.split(/[\r\n]+/).map(withoutControlSequences).filter(line => line.startsWith(prompt));
  if (redraws.length < 3 || redraws.at(-1).trimEnd() !== prompt) return null;

  const typed = input.trimStart();
  for (const line of redraws.slice(0, -2)) {
    const candidate = line.slice(prompt.length).trimStart();
    const suffix = candidate.slice(typed.length);
    if (suffix && candidate.toLowerCase().startsWith(typed.toLowerCase()) && /^[\w./:-]*[ \t]*$/.test(suffix)) {
      return candidate;
    }
  }
  return input;
}

function uploadLine(line, hosts) {
  const echoHost = (prompt.exec(line) || safeEcho.exec(line))?.[1];
  if (hosts.has(echoHost) || /^(?:\^|\[OK\]|Building configuration\.\.\.)$/.test(line)) return line;
  if (/^Destination filename \[startup-config\]\?$/i.test(line)) return line;
  if (/^Enter configuration commands, one per line\.(?: End with CNTL\/Z\.)?$/.test(line)) return line;
  if (/^% Invalid input detected at '\^' marker\.$/.test(line)) return line;
  if (/^% Incomplete command[.]?$/i.test(line)) return '% Incomplete command.';
  if (/^% Ambiguous command\b/i.test(line)) return '% Ambiguous command.';
  if (/^% Unrecognized command\b/i.test(line)) return '% Unrecognized command.';
  if (line.startsWith('%')) return 'IOS-melding. Zie de uploadstatus.';
  return '';
}

/** Renders output independently from the raw IOS replies used by the uploader. */
export class ConsoleTranscript {
  constructor({ showSensitive = false } = {}) {
    this.showSensitive = showSensitive;
    this.history = [];
    this.partial = '';
    this.truncated = false;
    this.mode = 'manual';
    this.prompt = '';
    this.password = false;
    this.more = false;
    this.question = false;
    this.uploadHosts = new Set();
    this.sensitiveInput = '';
  }

  get ready() {
    return execPrompt.test(this.prompt) && !this.more && !this.password;
  }

  get text() {
    const tail = this.visibleLine(this.currentLine(), true);
    return (tail ? [...this.history, tail] : this.history).join('\n');
  }

  beginInput(value = '', { password = this.password } = {}) {
    this.finishLine();
    this.mode = password || secretWords.test(value) ? 'secret' : 'manual';
    this.sensitiveInput = password ? value.trim() : '';
    this.prompt = '';
    this.password = false;
    this.more = false;
    this.question = false;
  }

  beginUpload(hostname) {
    this.uploadHosts = new Set([prompt.exec(this.prompt)?.[1], hostname].filter(Boolean));
    this.finishLine();
    this.mode = 'upload';
    this.sensitiveInput = '';
    this.prompt = '';
    this.password = false;
    this.more = false;
    this.question = false;
  }

  endUpload() {
    // Keep filtering late upload bytes until the first intentional manual input.
    this.finishLine();
  }

  feed(value) {
    for (const character of value) {
      if (character === '\r' || character === '\n') {
        this.finishLine();
      } else if (character === '\b' || character === '\x7f') {
        this.partial = this.partial.slice(0, -1);
      } else if (this.partial.length < maxLineLength) {
        this.partial += character;
      } else {
        this.truncated = true;
      }
    }
    this.observe(this.currentLine());
  }

  currentLine() {
    return this.truncated ? '' : withoutControlSequences(this.partial).trim();
  }

  observe(line) {
    if (!line && !this.truncated) return;
    const match = prompt.exec(line);
    const recognized = match && line !== this.sensitiveInput &&
      (this.mode !== 'upload' || this.uploadHosts.has(match[1]));
    this.prompt = recognized ? line : '';
    this.password = passwordPrompt.test(line);
    this.more = /--More--\s*$/i.test(line);
    this.question = this.mode === 'manual' && confirmation.test(line);
  }

  visibleLine(line, partial = false) {
    if (this.showSensitive) {
      const output = withoutControlSequences(this.partial);
      return this.truncated ? output + ' [Console-uitvoer ingekort]' : output;
    }
    if (this.truncated) return this.mode === 'manual' ? '[Console-uitvoer ingekort]' : '';
    if (line === this.sensitiveInput) return '';
    if (passwordPrompt.test(line)) return 'Password:';
    if (this.mode === 'upload') return uploadLine(line, this.uploadHosts);
    if (this.mode === 'secret') return prompt.test(line) ? line : '';
    if (partial && !prompt.test(line) && !/^(?:Username|Login):$/i.test(line) &&
      !/--More--\s*$/i.test(line) && !confirmation.test(line)) return '';
    if (secretWords.test(line)) return '[Gevoelige console-inhoud afgeschermd]';
    return line;
  }

  finishLine() {
    const line = this.currentLine();
    this.observe(line);
    const shown = this.visibleLine(line);
    if (shown) {
      this.history.push(shown);
      if (this.history.length > (this.showSensitive ? 2000 : 100)) this.history.shift();
    }
    if (this.mode === 'secret' && this.prompt === line && line) {
      this.mode = 'manual';
      this.sensitiveInput = '';
    }
    this.partial = '';
    this.truncated = false;
  }
}
