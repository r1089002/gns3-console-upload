const CORES = new Set(['SW-BRU-CORE1', 'SW-BRU-CORE2']);
const SOURCE_PORT = /^(?:GigabitEthernet|Gi)0\/0\/(\d+)$/i;
const ETHERNET = /\b(?:FastEthernet|GigabitEthernet|TenGigabitEthernet|Fa|Gi|Te)\d+(?:\/\d+){1,2}(?![\w/])/gi;
const BANNER = /^banner\s+\S+\s+(\^[A-Za-z@\[\]\\^_?]|.)(.*)$/i;
const PO1_MEMBERS = [47, 48];

export function isRack4CoreName(value) {
  return typeof value === 'string' && CORES.has(value.trim().toUpperCase());
}

function targetPort(source) {
  const match = SOURCE_PORT.exec(source);
  const number = Number(match?.[1]);
  if (!Number.isInteger(number) || number < 1 || number > 48) {
    throw Error('Rack 4 verwacht een R5-bron met interfaces Gi0/0/1 t/m Gi0/0/48.');
  }
  return 'GigabitEthernet1/0/' + number;
}

export function prepareRack4Core(rawConfig, name) {
  const lines = rawConfig.replace(/\r\n?/g, '\n').split('\n');
  const declared = lines.find(line => /^hostname\s+/i.test(line))?.trim().split(/\s+/)[1];
  if (!isRack4CoreName(name) || !isRack4CoreName(declared) ||
      declared.toUpperCase() !== name.trim().toUpperCase()) {
    throw Error('Rack 4 vereist de actuele configuratie van SW-BRU-CORE1 of SW-BRU-CORE2.');
  }

  let banner = null;
  let current = null;
  let hasPo1 = false;
  const members = new Map();
  const converted = lines.map(line => {
    if (banner) {
      if (line.includes(banner)) banner = null;
      return line;
    }
    const marker = BANNER.exec(line);
    if (marker) {
      if (!marker[2].includes(marker[1])) banner = marker[1];
      return line;
    }
    if (/^\s*(?:!|remark\b)/i.test(line)) return line;
    if (/^\s*description\b/i.test(line)) {
      // These two peer labels refer to the other Rack 4 core's Po1 members.
      return line.replace(/(SW-BRU-CORE[12][_\s-]+)(?:Gi|GigabitEthernet)0\/0\/(47-48|47|48)(?![\d/])/gi,
        (_, peer, ports) => peer + 'Gi1/0/' + ports);
    }

    const header = /^interface\s+(\S+)\s*$/i.exec(line);
    if (header) {
      if (/^Port-channel1$/i.test(header[1])) hasPo1 = true;
      const p = SOURCE_PORT.exec(header[1]);
      current = p ? Number(p[1]) : null;
    } else if (/^\S/.test(line)) {
      current = null;
    }

    const channel = /^\s*channel-group\s+1\s+mode\s+(\S+)\s*$/i.exec(line);
    if (channel) {
      if (current === null || channel[1].toLowerCase() !== 'active' || members.has(current)) {
        throw Error('Rack 4 verwacht twee actieve LACP-leden in Port-channel1.');
      }
      members.set(current, true);
    }
    return line.replace(ETHERNET, targetPort);
  });
  if (banner || !hasPo1 || members.size !== PO1_MEMBERS.length ||
      !PO1_MEMBERS.every(number => members.has(number))) {
    throw Error('Rack 4 verwacht Port-channel1 op Gi0/0/47 en Gi0/0/48 in de R5-bron.');
  }
  return { config: converted.join('\n') };
}
