export const PA440_101_TRAIN = '10.1';

// SHA-256 of the reviewed FW-NY target commands in upload order, with LF endings.
const reviewedCommandsHash = 'b85b9fb12c1b6c15de653a54bce201a998586f4fbd20103643bd49330ef655a6';
const vmMacSetting = /^set deviceconfig setting auto-mac-detect (?:yes|no)$/;
const explicitTunnelMode = /^set network tunnel ipsec [\w.-]+ ipsec-mode tunnel$/;

export async function preparePa440101(commands) {
  const translated = commands.filter(command => !vmMacSetting.test(command) && !explicitTunnelMode.test(command));
  const bytes = new TextEncoder().encode(translated.join('\n') + '\n');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return hash === reviewedCommandsHash ? translated : null;
}
