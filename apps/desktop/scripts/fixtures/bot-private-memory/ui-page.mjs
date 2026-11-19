export default {
  name: 'bot-private-memory', entry: './fixture.tsx', viewport: { width: 440, height: 660 },
  real: 'BotMemorySettings, local private source adapter, MemoryPreviewControl, translations and themed controls',
  notCovered: 'Host metadata, actual IPC/SQLite, real memory and model calls. Host reads return empty/error fixtures; preview stays off.',
  cases: {
    default: { about: 'Private memory empty state with preview disabled' },
    shared: { about: 'Another teammate uses this workspace: specific explanation' },
    isolation: { about: 'Private store location could not be verified: specific explanation' },
  },
  async ready(page) { await page.getByRole('button').first().waitFor(); },
  async check(page, ui) {
    await page.getByRole('button', { name: await ui.t('bots.memory.sourcePrivate'), exact: true }).click();
    const key = ui.case === 'default' ? 'empty' : ui.case === 'shared' ? 'privateWorkspaceConflict' : 'privateIsolationFailed';
    if (ui.case === 'default') await page.getByText(await ui.t(`bots.memory.${key}`), { exact: true }).waitFor();
    else await page.getByRole('alert').filter({ hasText: await ui.t(`bots.memory.${key}`) }).waitFor();
    const enabled = await page.getByRole('switch', { name: await ui.t('bots.memory.previewLabel'), exact: true }).getAttribute('aria-checked');
    if (enabled !== 'false') throw new Error('Preview must remain disabled');
    await ui.capture('private');
  },
};
