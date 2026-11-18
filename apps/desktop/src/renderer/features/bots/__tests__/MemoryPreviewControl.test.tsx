// @vitest-environment jsdom
// Component + mocked preload fixtures; not a real Electron acceptance.
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
vi.mock('../botPronounContext', () => ({ useBotTranslation: () => ({ t: (key: string) => key }) }));
import { MemoryPreviewControl } from '../MemoryPreviewControl';
afterEach(cleanup);
const initial = {
  botId: 'bot-fixture',
  enabled: false,
  revision: 'v1',
  model: 'fixture',
  available: true,
  reason: null,
};
function api() {
  const get = vi.fn(async () => initial),
    set = vi.fn(async () => ({ ...initial, enabled: true, revision: 'v2' }));
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { localDb: { bots: { memoryPreview: { get, set } } } },
  });
  return { get, set };
}
it('only explicit switch writes, using the loaded revision; changed routes can be disabled', async () => {
  const f = api();
  render(<MemoryPreviewControl botId="bot-fixture" assertCurrent={() => {}} />);
  await waitFor(() => expect(screen.getByRole('switch').getAttribute('disabled')).toBe(null));
  expect(f.set).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('switch'));
  await waitFor(() =>
    expect(f.set).toHaveBeenCalledWith({
      botId: 'bot-fixture',
      enabled: true,
      expectedRevision: 'v1',
    }),
  );
  await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'));
});
it('conflicts show failure without claiming the preference changed', async () => {
  const f = api();
  f.set.mockRejectedValue(Error('MEMORY_PREVIEW_CHANGED'));
  render(<MemoryPreviewControl botId="bot-fixture" assertCurrent={() => {}} />);
  await waitFor(() => expect(screen.getByRole('switch').getAttribute('disabled')).toBe(null));
  fireEvent.click(screen.getByRole('switch'));
  await screen.findByRole('alert');
  expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
});
it('a late old-bot response cannot overwrite the new view', async () => {
  const f = api();
  let release!: (v: any) => void;
  f.get.mockImplementationOnce(() => new Promise((r) => (release = r)));
  const current = () => {};
  const view = render(<MemoryPreviewControl botId="bot-fixture" assertCurrent={current} />);
  await waitFor(() => expect(f.get).toHaveBeenCalledOnce());
  f.get.mockResolvedValue({ ...initial, botId: 'second' });
  view.rerender(<MemoryPreviewControl botId="second" assertCurrent={current} />);
  await waitFor(() => expect(screen.getByRole('switch').getAttribute('disabled')).toBe(null));
  release({ ...initial, enabled: true });
  await waitFor(() =>
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'),
  );
  expect(f.set).not.toHaveBeenCalled();
});
