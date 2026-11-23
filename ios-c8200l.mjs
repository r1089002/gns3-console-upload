const GIGABIT_PORT = String.raw`((?:GigabitEthernet|Gi)[ \t]*)(\d+\/\d+(?:\/\d+)?)(\.\d+)?`;
const INTERFACE = new RegExp(String.raw`^(interface[ \t]+)${GIGABIT_PORT}([ \t]*)$`, 'i');
const IPV4 = String.raw`(?:\d{1,3}\.){3}\d{1,3}`;
const GLOBAL_REFERENCE = new RegExp(
  String.raw`^((?:ip[ \t]+route[ \t]+${IPV4}[ \t]+${IPV4}|ip[ \t]+tftp[ \t]+source-interface|logging[ \t]+source-interface|ntp[ \t]+source)[ \t]+)${GIGABIT_PORT}([ \t].*)?$`,
  'i',
);
const BANNER = /^banner[ \t]+\S+[ \t]+(\^[A-Za-z@\[\\\]^_?]|.)(.*)$/i;
const VIRTUAL_PORTS = new Map([
  ['0/0', '0/0/0'], ['0/1', '0/0/1'], ['0/2', '0/0/2'], ['0/3', '0/0/3'],
]);
const VIRTUAL_MMI_DEFAULTS = new Set([
  'mmi polling-interval 60', 'no mmi auto-configure', 'no mmi pvc', 'mmi snmp-timeout 180',
]);
const IPV6_DEFAULTS = new Set(['no ipv6 cef', 'ipv6 ioam timestamp']);
const PPP_DEFAULT = 'multilink bundle-name authenticated';
const EMPTY_VIRTUAL_STANZAS = new Set(['line aux 0', 'control-plane', 'redundancy']);
const AUTO_SPEED_DUPLEX = new Set(['speed auto', 'duplex auto']);

const normalized = line => line.trim().replace(/[ \t]+/g, ' ').toLowerCase();

function splitStanzas(rawConfig) {
  const lines = rawConfig.split(/(\r\n|\n|\r)/);
  const stanzas = [];
  let stanza;
  let bannerDelimiter = null;

  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index];
    const newline = lines[index + 1] ?? '';
    if (!stanza || (!bannerDelimiter && /^\S/.test(line))) {
      stanza = [];
      stanzas.push(stanza);
    }
    stanza.push({ line, newline });

    if (bannerDelimiter) {
      if (line.includes(bannerDelimiter)) bannerDelimiter = null;
    } else if (stanza.length === 1) {
      const banner = BANNER.exec(line);
      if (banner && !banner[2].includes(banner[1])) bannerDelimiter = banner[1];
    }
  }
  return stanzas;
}

function usedProtocolFeatures(stanzas) {
  const commands = stanzas.filter(([first]) => !BANNER.test(first.line)).flat();
  let ipv6 = false;
  let ppp = false;
  for (const { line } of commands) {
    const command = normalized(line);
    if (!command || command.startsWith('!')) continue;
    const global = /^\S/.test(line);
    if (!(global && IPV6_DEFAULTS.has(command)) &&
        /\b(?:ipv6|vpnv6)\b|(?:^| )(?:(?:[\da-f]{1,4}:){3}|[\da-f:]*::)[\da-f:]*/.test(command)) {
      ipv6 = true;
    }
    if (!(global && command === PPP_DEFAULT) &&
        /\b(?:ppp|pppoe|multilink|dialer|virtual-template|virtual-access)(?=\b|\d)/.test(command)) {
      ppp = true;
    }
  }
  return { ipv6, ppp };
}

function rackPort(port, observed) {
  if (port.split('/').length === 3) {
    observed.physical = true;
  } else {
    if (!VIRTUAL_PORTS.has(port)) {
      throw Error('Dit Catalyst 8200L-profiel heeft geen poortkoppeling voor deze GigabitEthernet-interface.');
    }
    observed.virtual = true;
  }
  if (observed.physical && observed.virtual) {
    throw Error('De bron gebruikt zowel virtuele als fysieke GigabitEthernet-poortnummers.');
  }
  return VIRTUAL_PORTS.get(port);
}

function writePortSettings(children, isCopper, newline, output, changes) {
  const childIndents = children.map(({ line }) => /^[ \t]+(?=[^ \t!])/.exec(line)?.[0]);
  const indent = childIndents.find(Boolean) ?? ' ';
  const direct = new Map();
  for (const [index, childIndent] of childIndents.entries()) {
    if (childIndent === indent) direct.set(index, normalized(children[index].line));
  }
  const commands = new Set(direct.values());
  let addNegotiation = isCopper && commands.has('speed auto') && commands.has('duplex auto') &&
    !Array.from(commands).some(command => /^(?:(?:no|default) )?negotiation(?: |$)/.test(command));

  let enableAt = -1;
  if (!commands.has('shutdown') && !commands.has('no shutdown')) {
    // Stay in interface mode when the source explicitly exits or enters a submode.
    const nestedAt = childIndents.findIndex(value => value?.length > indent.length);
    const lastDirectBeforeNested = Array.from(direct.keys()).findLast(index => index < nestedAt);
    const exitAt = Array.from(direct.entries()).find(([, command]) => /^(?:exit|end)$/.test(command))?.[0];
    enableAt = Math.min(lastDirectBeforeNested ?? children.length, exitAt ?? children.length);
    changes.enabledInterfaces++;
  }
  const enable = () => output.push(indent, 'no shutdown', newline || '\n');

  for (const [index, child] of children.entries()) {
    if (index === enableAt) enable();
    const command = direct.get(index);
    if (command === 'media-type rj45') {
      changes.media++;
      continue;
    }
    if (AUTO_SPEED_DUPLEX.has(command)) {
      changes.speedDuplex++;
      if (addNegotiation) {
        output.push(indent, 'negotiation auto', child.newline || newline || '\n');
        addNegotiation = false;
        changes.negotiation++;
      }
      continue;
    }
    output.push(child.line, child.newline);
  }
  if (enableAt === children.length) enable();
}

/** Adapt IOSv interface syntax to the Catalyst 8200L onboard ports in the Rack 4 design. */
export function prepareC8200L(rawConfig) {
  const changes = {
    mmi: 0, interfaces: 0, references: 0, media: 0, speedDuplex: 0, negotiation: 0, enabledInterfaces: 0,
    ipv6Defaults: 0, pppDefaults: 0, emptyStanzas: 0,
  };
  const observed = { virtual: false, physical: false };
  const mappedHeaders = new Set();
  const output = [];
  const stanzas = splitStanzas(rawConfig);
  const features = usedProtocolFeatures(stanzas);
  for (const [first, ...children] of stanzas) {
    const { line, newline } = first;
    const globalCommand = /^\S/.test(line) ? normalized(line) : '';
    if (VIRTUAL_MMI_DEFAULTS.has(globalCommand)) {
      changes.mmi++;
    } else if (!features.ipv6 && IPV6_DEFAULTS.has(globalCommand)) {
      changes.ipv6Defaults++;
    } else if (!features.ppp && globalCommand === PPP_DEFAULT) {
      changes.pppDefaults++;
    } else if (EMPTY_VIRTUAL_STANZAS.has(globalCommand) &&
               children.every(child => !child.line.trim() || child.line.trimStart().startsWith('!'))) {
      changes.emptyStanzas++;
    } else {
      const match = INTERFACE.exec(line) ?? GLOBAL_REFERENCE.exec(line);
      const port = match ? rackPort(match[3], observed) : undefined;
      if (!port) {
        output.push(line, newline);
      } else {
        const [, prefix, name, virtual, suffix = '', tail = ''] = match;
        output.push(prefix, name, port, suffix, tail, newline);
        if (/^interface[ \t]/i.test(prefix)) {
          const key = port + suffix;
          if (mappedHeaders.has(key)) throw Error('Dezelfde fysieke poort staat meermaals in de bronconfiguratie.');
          mappedHeaders.add(key);
          changes.interfaces++;
          if (!suffix) {
            writePortSettings(children, virtual === '0/0' || virtual === '0/1', newline, output, changes);
            continue;
          }
        } else {
          changes.references++;
        }
      }
    }
    for (const child of children) output.push(child.line, child.newline);
  }
  return { config: output.join(''), changes };
}
