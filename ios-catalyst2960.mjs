const FAST_ETHERNET = /^interface[ \t]+(?:FastEthernet|Fa)0\/(?:[1-9]|1\d|2[0-4])[ \t]*$/i;
const BANNER = /^banner[ \t]+\S+[ \t]+(\^[A-Za-z@\[\\\]^_?]|.)(.*)$/i;
const PREAMBLE = /^(?:\s*!.*|\s*(?:Building configuration\.\.\.|Current configuration\s*:\s*\d+ bytes|show running-config)\s*)$/;
const SELF_SIGNED_PKI = /^crypto[ \t]+pki[ \t]+(trustpoint|certificate[ \t]+chain)[ \t]+(TP-self-signed-\d+)[ \t]*$/i;
const SELF_SIGNED_CERTIFICATE = /^[ \t]+certificate[ \t]+self-signed[ \t]+[\da-f]+(?:[ \t]+nvram:[\w./-]+\.cer)?[ \t]*$/i;
const GLOBAL_OMISSIONS = new Map([
  ['no ip cef', 'ipv4Cef'],
  ['no ipv6 cef', 'ipv6Cef'],
  ['ip forward-protocol nd', 'forwardProtocolNd'],
  ['line aux 0', 'auxiliaryLines'],
]);

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

function pairedSelfSignedStanzas(stanzas) {
  const profiles = new Map();
  for (const stanza of stanzas) {
    const match = SELF_SIGNED_PKI.exec(stanza[0].line);
    if (!match) continue;
    const name = match[2].toLowerCase();
    if (!profiles.has(name)) profiles.set(name, { trustpoints: [], chains: [] });
    const profile = profiles.get(name);
    if (match[1].toLowerCase() === 'trustpoint') profile.trustpoints.push(stanza);
    else profile.chains.push(stanza);
  }

  const pairs = new Set();
  for (const { trustpoints, chains } of profiles.values()) {
    if (trustpoints.length !== 1 || chains.length !== 1) continue;
    const [trustpoint] = trustpoints;
    const [chain] = chains;
    const selfSignedEnrollment = trustpoint.some(({ line }) => /^[ \t]+enrollment[ \t]+selfsigned[ \t]*$/i.test(line));
    const firstChild = chain.slice(1).find(({ line }) => line.trim());
    const certificates = chain.filter(({ line }) => /^[ \t]+certificate[ \t]+/i.test(line));
    if (selfSignedEnrollment && certificates.length === 1 && SELF_SIGNED_CERTIFICATE.test(firstChild?.line ?? '')) {
      pairs.add(trustpoint);
      pairs.add(chain);
    }
  }
  return pairs;
}

function writeFastEthernet(stanza, changes, output) {
  let interfaceIndent = null;
  for (const { line, newline } of stanza) {
    const indent = /^[ \t]+/.exec(line)?.[0];
    const command = normalized(line);
    if (indent && command && !command.startsWith('!')) {
      interfaceIndent ??= indent;
      if (indent === interfaceIndent) {
        switch (command) {
          case 'negotiation auto':
            changes.negotiation++;
            output.push(indent, 'speed auto', newline || '\n', indent, 'duplex auto', newline);
            continue;
          case 'spanning-tree portfast edge':
            changes.portfast++;
            output.push(indent, 'spanning-tree portfast', newline);
            continue;
          case 'switchport trunk encapsulation dot1q':
            changes.trunkEncapsulation++;
            continue;
        }
      }
    }
    output.push(line, newline);
  }
}

export function prepareCatalyst2960(rawConfig) {
  const changes = {
    version: 0, ipv4Cef: 0, ipv6Cef: 0, forwardProtocolNd: 0,
    sshCipherPolicies: 0, auxiliaryLines: 0, selfSignedPki: 0, emptyControlPlane: 0,
    negotiation: 0, portfast: 0, trunkEncapsulation: 0,
  };
  const stanzas = splitStanzas(rawConfig);
  const selfSigned = pairedSelfSignedStanzas(stanzas);
  const output = [];
  let beforeHeader = true;

  changes.selfSignedPki = selfSigned.size / 2;
  for (const stanza of stanzas) {
    const { line, newline } = stanza[0];
    const command = normalized(line);
    const global = /^\S/.test(line);
    const sshCipherPolicy = global && /^ip ssh (?:server|client) algorithm encryption(?: |$)/.test(command);
    const emptyControlPlane = global && command === 'control-plane' && stanza.slice(1).every(child => !child.line.trim());
    const omission = sshCipherPolicy ? 'sshCipherPolicies' : emptyControlPlane ? 'emptyControlPlane'
      : global ? GLOBAL_OMISSIONS.get(command) : undefined;

    if (beforeHeader && command && !PREAMBLE.test(line)) {
      beforeHeader = false;
      if (/^version[ \t]+15\.2[ \t]*$/i.test(line)) {
        changes.version++;
        output.push(line.replace('15.2', '15.0'), newline);
        for (const child of stanza.slice(1)) output.push(child.line, child.newline);
        continue;
      }
    }

    if (omission || selfSigned.has(stanza)) {
      if (omission) changes[omission]++;
      const body = stanza.slice(1);
      const keep = omission && omission !== 'auxiliaryLines' ? body : body.filter(child => !child.line.trim());
      for (const child of keep) output.push(child.line, child.newline);
    } else if (FAST_ETHERNET.test(line)) {
      writeFastEthernet(stanza, changes, output);
    } else {
      for (const child of stanza) output.push(child.line, child.newline);
    }
  }
  return { config: output.join(''), changes };
}
