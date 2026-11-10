import assert from 'node:assert/strict';

/** 待办页（docs/product-rules/cindy-bots-runtime.md §6.3.6「桌面待办页」）。 */
export default {
  name: 'teammate-todos',
  entry: './todos-fixture.tsx',
  viewport: { width: 1180, height: 820 },
  real: 'TeammateTodosView (deadline sections, teammate/type/status filters, done fold, offline notes, due dots), botGlanceTodos reading over local host and device-link resources, SegmentedControl, Tip, theme and translations',
  notCovered:
    'The sidebar entry and its count, live pushes and foreground refresh, a teammate going offline after its todos were read, cloud companions, opening the teammate conversation',
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
    default: { about: 'Three teammates, one offline: every deadline section, a decision to make, suggested date, done fold' },
    empty: { about: 'No todos anywhere: one sentence and a way into a teammate chat' },
  },
  async ready(page) {
    await page.getByTestId('todo-board').waitFor();
  },
  async check(page, ui) {
    if (ui.case === 'personal-row') {
      await page.getByRole('radio', { name: await ui.t('personalTodos.mine'), exact: true }).click();
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
    await ui.capture('personal-empty');
    await page.getByRole('button', { name: await ui.t('personalTodos.add') }).click();
    await ui.capture('personal-editor-empty');
    await page.getByRole('button', { name: await ui.t('personalTodos.close') }).click();
    await page.getByRole('radio', { name: await ui.t('personalTodos.teammates'), exact: true }).click();
    if (ui.case === 'empty') {
      await page.getByTestId('todo-board-empty').waitFor();
      return;
    }
    await page.getByTestId('todo-board-row').first().waitFor();
    assert.equal(await page.getByTestId('todo-board-row').count(), 6, 'open todos of the local and online remote teammate');
    assert.equal(await page.getByTestId('todo-board-notes').count(), 1, 'offline teammate is called out');
    await ui.capture('open');
    await page.getByRole('button', { name: await ui.t('bots.glance.doneCount', { count: 1 }) }).click();
    await ui.capture('done-expanded');
    await page.getByTestId('todo-board-row').first().hover();
    await page.getByRole('tooltip').first().waitFor();
    await ui.capture('hover');
  },
};
