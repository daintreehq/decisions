/**
 * Every way pairing can fail, as the person should hear it: what happened, what to do, and how serious it is. The
 * security stops say plainly not to retry with the same code. Messages come from data/pairing.ts and app/invite.ts.
 */
export interface PairingProblem {
  title: string;
  body: string;
  tone: 'warn' | 'error';
  /** The recovery offered: start again with a new code, or reload into a newer app. */
  action: 'start-again' | 'reload';
}

export function pairingProblem(message: string): PairingProblem {
  const m = message.toLowerCase();
  if (m.includes('newer version'))
    return {
      title: 'This pairing code needs a newer Decisions',
      body: 'Reload to get the latest version from your relay, then scan the code again.',
      tone: 'warn',
      action: 'reload',
    };
  if (m.includes('different relay'))
    return {
      title: 'This code is for a different relay',
      body: 'Open Decisions at the address your computer shows next to the code, then pair there.',
      tone: 'warn',
      action: 'start-again',
    };
  if (m.includes('expired') || m.includes('timed out'))
    return {
      title: 'The pairing code expired',
      body: 'Codes last a few minutes. On your computer, start pairing again to show a new code.',
      tone: 'warn',
      action: 'start-again',
    };
  if (m.includes('declined'))
    return {
      title: 'Pairing was declined on your computer',
      body: 'If that wasn’t you, nothing was paired. To try again, start pairing on your computer.',
      tone: 'warn',
      action: 'start-again',
    };
  if (m.includes('could not reach') || m.includes('network'))
    return {
      title: 'Couldn’t reach your relay',
      body: 'Check your connection, then scan the code again.',
      tone: 'warn',
      action: 'start-again',
    };
  if (
    m.includes('does not match') ||
    m.includes('is wrong') ||
    m.includes('not signed') ||
    m.includes('without credentials')
  )
    return {
      title: 'Pairing was stopped to protect you',
      body: 'What your relay sent didn’t match the code from your computer. Don’t retry with this code: start a new pairing in Daintree. If it happens again, check your relay’s deployment.',
      tone: 'error',
      action: 'start-again',
    };
  if (m.includes('not valid') || m.includes('not a decisions') || m.includes('invalid'))
    return {
      title: 'That isn’t a Decisions pairing code',
      body: 'Scan the code Daintree shows in Settings › Decisions › Pair a phone, or copy its link.',
      tone: 'warn',
      action: 'start-again',
    };
  if (m.includes('unsupported device role'))
    return {
      title: 'This code is for another kind of device',
      body: 'Start pairing on your computer and choose a phone or tablet.',
      tone: 'warn',
      action: 'start-again',
    };
  return {
    title: 'Pairing didn’t finish',
    body: `${message.replace(/\.$/, '')}. Start pairing again on your computer.`,
    tone: 'warn',
    action: 'start-again',
  };
}

/** "123456" or "123 456" → ["123", "456"]. */
export function codeGroups(code: string): string[] {
  const digits = code.replace(/\D/g, '');
  const out: string[] = [];
  for (let i = 0; i < digits.length; i += 3) out.push(digits.slice(i, i + 3));
  return out;
}

/** "1 2 3 4 5 6": screen readers read it digit by digit instead of as a number. */
export function spokenCode(code: string): string {
  return code.replace(/\D/g, '').split('').join(' ');
}
