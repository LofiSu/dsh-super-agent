import { createHash } from 'node:crypto';

const prefix = '// dsh-super-bot generated sha256: ';

function digest(source) {
  return createHash('sha256').update(source).digest('hex');
}

export function prepareBotInstall(installed, generated, upgrading) {
  if (upgrading && installed !== generated) {
    const newline = installed.indexOf('\n');
    const body = installed.slice(newline + 1);
    if (newline < 0 || installed.slice(0, newline) !== prefix + digest(body)) {
      throw new Error('Bot installer cannot verify the current file. Preserve local edits before reinstalling.');
    }
  }
  return prefix + digest(generated) + '\n' + generated;
}
