import assert from 'node:assert/strict';

/** 待办页（只列当前账号的个人待办）。 */
export default {
  name: 'teammate-todos',
  entry: './todos-fixture.tsx',
  viewport: { width: 1180, height: 820 },
  real: 'TeammateTodosView (personal todos: priority rings, tags, deadline text, grouping menu, tag chips, inline composer with date phrase recognition, details panel), the personal todo read over the local host resource, the shared task-tag cache, SegmentedControl, DropdownMenu, Tip, theme and translations',
  notCovered:
    'Saving anything (personal writes are forbidden here), creating a tag, the sidebar entry and its count, live pushes and foreground refresh',
  stubs: {
    'src/renderer/contexts/AuthContext': { partial: `export const useOptionalDataOwnerGeneration=()=>0;` },
  },
  cases: {
    'personal-row': { about: 'UNIT FIXTURE: one personal row, checkbox/opener siblings and keyboard focus. No model, account, writes, or simulated save results.' },
    default: { about: 'Personal todos with priorities, tags, overdue/today/week/later, a snoozed and finished items; composer with a recognised date phrase, grouping menu, details panel. Fixture data only; saving is forbidden' },
    'sync-home': { about: 'Sync bar: this computer is the main computer (fixture data)' },
    'sync-pending': { about: 'Sync bar: replica, main computer online, 3 edits pending' },
    'sync-offline': { about: 'Sync bar: replica, main computer offline' },
    'sync-remote-off': { about: 'Sync bar: replica, main computer has remote control off' },
    'sync-conflict-row': { about: 'A refused edit marks its row with the two choices' },
    'sync-conflict-draft': { about: 'A refused creation shows as a marked draft row' },
    empty: { about: 'No todos: one sentence and the composer' },
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
      await row.getByRole('button', { name: '[fixture] Personal row — layout only', exact: true }).click();
      await ui.capture('personal-existing-details-unit-fixture');
      return;
    }
    if (ui.case === 'default') {
      await page.getByTestId('todo-board-row').first().waitFor();
      assert.equal(await page.getByTestId('todo-board-row').count(), 9, 'open personal todos, snoozed and finished ones kept out');
      await ui.capture('personal-list');

      // Composer with a recognised date phrase (Chinese and English only).
      await page.getByRole('button', { name: await ui.t('personalTodos.add'), exact: true }).click();
      const phrase = ui.locale.startsWith('zh') ? '明天下午3点交季度报告' : 'send the quarterly report tomorrow at 3pm';
      await page.getByRole('textbox', { name: await ui.t('personalTodos.title'), exact: true }).fill(phrase);
      if (/^(zh|en)/.test(ui.locale)) {
        const shown = ui.locale.startsWith('zh') ? '明天下午3点' : 'tomorrow at 3pm';
        await page.getByRole('button', { name: await ui.t('personalTodos.composer.dismissRecognition', { phrase: shown }) }).waitFor();
      }
      await ui.capture('composer-recognized');

      // The real menus: priority, date (a hand-picked date replaces the recognised one) and the new-tag form.
      await page.getByRole('button', { name: await ui.t('personalTodos.priority.label'), exact: true }).click();
      await page.getByRole('menuitemradio', { name: await ui.t('personalTodos.priority.high'), exact: true }).waitFor();
      await ui.capture('priority-menu');
      await page.getByRole('menuitemradio', { name: await ui.t('personalTodos.priority.high'), exact: true }).click();
      await page.getByRole('button', { name: await ui.t('personalTodos.priority.short.high'), exact: true }).waitFor();
      await page.locator('button:has(svg.lucide-calendar)').click();
      await page.getByRole('menuitem', { name: new RegExp(await ui.t('personalTodos.due.nextMonday')) }).waitFor();
      await ui.capture('date-menu');
      await page.getByRole('menuitem', { name: new RegExp(await ui.t('personalTodos.due.nextMonday')) }).click();
      assert.equal(await page.getByRole('button', { name: /dismiss|不识别|認識/ }).count(), 0, 'a picked date replaces the recognised one');
      await page.locator('button:has(svg.lucide-tag)').click();
      await page.getByRole('menuitem', { name: await ui.t('personalTodos.newTag'), exact: true }).click();
      await page.getByRole('textbox', { name: await ui.t('taskTags.name'), exact: true }).waitFor();
      await ui.capture('new-tag-form');
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('textbox', { name: await ui.t('taskTags.name'), exact: true }).count(), 0);

      // Grouping and order menu.
      await page.getByRole('button', { name: await ui.t('personalTodos.group.due') }).click();
      await page.getByRole('menuitemradio', { name: await ui.t('personalTodos.order.created') }).waitFor();
      await ui.capture('grouping-menu');
      await page.keyboard.press('Escape');

      // Tag chip filter, then the details panel of one row.
      await page.getByRole('button', { name: /生活|Life/ }).first().click();
      await ui.capture('tag-filtered');
      await page.getByRole('button', { name: new RegExp('^(' + (await ui.t('personalTodos.all')) + ')') }).first().click();
      // A todo with steps: progress in the meta line and its steps expanded inline (a long step wraps).
      const stepsRow = page.getByTestId('todo-board-row').filter({ hasText: '回复供应商报价邮件' });
      await stepsRow.getByText('1/3').waitFor();
      await stepsRow.getByRole('button', { name: await ui.t('personalTodos.steps.expand', { title: '回复供应商报价邮件' }), exact: true }).click();
      await stepsRow.getByRole('checkbox', { name: await ui.t('personalTodos.steps.complete', { title: '确认交期' }) }).waitFor();
      await ui.capture('steps-inline');
      // The add row opens a field; a row without steps shows a ghost add button on hover.
      await stepsRow.getByRole('button', { name: await ui.t('personalTodos.steps.add'), exact: true }).click();
      await stepsRow.getByRole('textbox', { name: await ui.t('personalTodos.steps.name'), exact: true }).fill('发送确认邮件');
      await ui.capture('steps-adding');
      await stepsRow.getByRole('button', { name: await ui.t('personalTodos.steps.cancel'), exact: true }).dispatchEvent('mousedown');
      const plainRow = page.getByTestId('todo-board-row').filter({ hasText: '预约体检' });
      await plainRow.hover();
      await plainRow.getByRole('button', { name: await ui.t('personalTodos.steps.addTo', { title: '预约体检' }), exact: true }).waitFor();
      await ui.capture('steps-ghost-add');

      await page.getByRole('button', { name: '准备周会材料', exact: true }).click();
      await page.getByRole('complementary').waitFor();
      await page.getByRole('complementary').getByRole('checkbox', { name: await ui.t('personalTodos.steps.complete', { title: '打印会议材料' }) }).waitFor();
      // The reminder control must fit the panel in every language (long labels would otherwise scroll).
      const reminder = page.getByRole('radiogroup', { name: await ui.t('personalTodos.reminder.label') });
      assert.equal(await reminder.evaluate((element) => element.scrollWidth <= element.clientWidth), true, 'reminder options fit the panel');
      await ui.capture('details');
      return;
    }
    if (ui.case.startsWith('sync-')) {
      await page.getByTestId('todo-sync-bar').waitFor();
      if (ui.case.startsWith('sync-conflict')) await page.getByTestId('todo-sync-conflict').waitFor();
      await ui.capture(ui.case);
      return;
    }
    await page.getByTestId('todo-board-empty').waitFor();
    await ui.capture('empty');
  },
};
