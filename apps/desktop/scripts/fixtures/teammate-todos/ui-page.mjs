import assert from 'node:assert/strict';

/** 待办页（只列个人待办）。 */
export default {
  name: 'teammate-todos',
  entry: './todos-fixture.tsx',
  viewport: { width: 1180, height: 820 },
  real: 'TeammateTodosView (personal todos: deadline sections, open/later/done views, done fold, due dots, editor), personal todo read over the local host resource, SegmentedControl, theme and translations',
  notCovered:
    'The sidebar entry and its count, saving, completing and deleting (writes are forbidden in the fixture)',
  stubs: {
    'src/renderer/contexts/AuthContext': { partial: `export const useOptionalDataOwnerGeneration=()=>0;` },
  },
  cases: {
    'personal-row': { about: 'UNIT FIXTURE: one personal row, checkbox/opener siblings and keyboard focus. No model, account, writes, or simulated save results.' },
    default: { about: 'Personal todos in every deadline section, a deferred one and a done fold' },
    empty: { about: 'No todos: one sentence' },
  },
  async ready(page) {
    await page.getByTestId('todo-board').waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'personal-row') {
      const row = page.getByTestId('todo-board-row');
      await row.waitFor();
      assert.equal(await row.locator('button button').count(), 0);
      const checkbox = row.getByRole('checkbox');
      assert.equal(await checkbox.getAttribute('aria-checked'), 'false');
      await checkbox.focus();
      await ui.capture('personal-row-keyboard-focus-unit-fixture');
      await row.getByRole('button', { name: '[fixture] Personal row — layout only' }).click();
      await ui.capture('personal-existing-details-unit-fixture');
      return;
    }
    if (ui.case === 'empty') {
      await page.getByTestId('todo-board-empty').waitFor();
      await ui.capture('empty');
      await page.getByRole('button', { name: await ui.t('personalTodos.add') }).click();
      await ui.capture('personal-editor-empty');
      return;
    }
    await page.getByTestId('todo-board-row').first().waitFor();
    assert.equal(await page.getByTestId('todo-board-row').count(), 5, 'open personal todos');
    await ui.capture('open');
    await page.getByRole('button', { name: await ui.t('bots.glance.doneCount', { count: 1 }) }).click();
    await ui.capture('done-expanded');
    await page.getByRole('button', { name: await ui.t('personalTodos.add') }).click();
    await ui.capture('personal-editor-empty');
  },
};
