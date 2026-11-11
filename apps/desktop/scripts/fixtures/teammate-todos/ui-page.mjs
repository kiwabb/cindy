import assert from 'node:assert/strict';

const named = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( \\d+)?$`);

/** 待办页（docs/product-rules/cindy-bots-runtime.md §6.3.6「桌面待办页」）。 */
export default {
  name: 'teammate-todos',
  entry: './todos-fixture.tsx',
  viewport: { width: 1180, height: 820 },
  real: 'TeammateTodosView (my todos: priority rings, tags, deadline text, grouping menu, tag chips, inline composer with date phrase recognition, details panel; teammate todos: deadline sections, teammate/type/status filters, offline notes, due dots), botGlanceTodos reading over local host and device-link resources, the shared task-tag cache, SegmentedControl, DropdownMenu, Popover, Tip, theme and translations',
  notCovered:
    'Saving anything (personal writes are forbidden here), creating a tag, the sidebar entry and its count, live pushes and foreground refresh, a teammate going offline after its todos were read, cloud companions, opening the teammate conversation',
  stubs: {
    'src/renderer/contexts/AuthContext': { partial: `export const useOptionalDataOwnerGeneration=()=>0;` },
    'src/renderer/features/bots/botStore': {
      partial: `export const useBotProfiles=()=>[{id:'cindy-default',name:'Cindy',avatar:'cindy://avatar/preset/cindy',avatarColor:'violet',status:'active'}];`,
    },
    'src/renderer/features/bots/useRemoteBots': `export const useRemoteCindyIds=()=>new Set(); export const useRemoteBots=()=>[
      {id:'dev',name:'开发管家',deviceId:'mini',deviceName:'Mac mini',online:true,avatar:'',avatarColor:'blue'},
      {id:'life',name:'栖物生活',deviceId:'home',deviceName:'家里的 Mac mini',online:false,connectionKnown:true,avatar:'',avatarColor:'green'}];`,
    'src/renderer/features/bots/companionCloudStore': {
      partial: `export const useCompanionCloud=()=>({enabled:false,selfDeviceId:null,actors:[],demotedBotIds:[]});`,
    },
  },
  cases: {
    'personal-row': { about: 'UNIT FIXTURE: one personal row, checkbox/opener siblings and keyboard focus. No model, account, writes, or simulated save results.' },
    personal: { about: 'My todos with priorities, tags, overdue/today/week/later, a snoozed and finished items; composer with a recognised date phrase, grouping menu, details panel. Fixture data only; saving is forbidden' },
    default: { about: 'Three teammates, one offline: every deadline section, a decision to make, suggested date, filter popover' },
    empty: { about: 'No todos anywhere: one sentence and a way into a teammate chat' },
  },
  async ready(page) {
    await page.getByTestId('todo-board').waitFor();
  },
  async check(page, ui) {
    const mine = await ui.t('personalTodos.mine');
    const teammates = await ui.t('personalTodos.teammates');
    const view = async (key) => page.getByRole('radio', { name: named(await ui.t(key)) });
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
    if (ui.case === 'personal') {
      await page.getByTestId('todo-board-row').first().waitFor();
      assert.equal(await page.getByRole('radio', { name: named(mine) }).getAttribute('aria-checked'), 'true');
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
      await page.getByRole('button', { name: '准备周会材料', exact: true }).click();
      await page.getByRole('complementary').waitFor();
      // The reminder control must fit the panel in every language (long labels would otherwise scroll).
      const reminder = page.getByRole('radiogroup', { name: await ui.t('personalTodos.reminder.label') });
      assert.equal(await reminder.evaluate((element) => element.scrollWidth <= element.clientWidth), true, 'reminder options fit the panel');
      await ui.capture('details');
      return;
    }
    await ui.capture('personal-empty');
    await page.getByRole('radio', { name: named(teammates) }).click();
    if (ui.case === 'empty') {
      await page.getByTestId('todo-board-empty').waitFor();
      return;
    }
    await page.getByTestId('todo-board-row').first().waitFor();
    assert.equal(await page.getByTestId('todo-board-row').count(), 6, 'open todos of the local and online remote teammate');
    assert.equal(await page.getByTestId('todo-board-notes').count(), 1, 'offline teammate is called out');
    await ui.capture('open');
    await page.getByRole('button', { name: await ui.t('bots.todoBoard.filter') }).click();
    await page.getByRole('radio', { name: await ui.t('bots.todoBoard.origin.discovered'), exact: true }).waitFor();
    await ui.capture('filter-popover');
    await page.keyboard.press('Escape');
    await (await view('bots.todoBoard.view.done')).click();
    await ui.capture('done');
    await (await view('bots.todoBoard.view.open')).click();
    await page.getByTestId('todo-board-row').first().hover();
    await page.getByRole('tooltip').first().waitFor();
    await ui.capture('hover');
  },
};
