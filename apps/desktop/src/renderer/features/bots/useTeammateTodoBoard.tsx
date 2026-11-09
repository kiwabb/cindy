import { usePersonalTodoSnapshot } from './usePersonalTodoSnapshot';
import { personalTodoIsOpen } from './personalTodoCache';
/**
 * 待办页与侧栏「待办」入口共用的伙伴名单和读取。每位伙伴仍走近况那条读取路径
 * （`useGlanceTodos`：本机读宿主，别的电脑经 device-link 远程资源），这里不新增通道。
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { isBotKnownOffline } from './BotConnectionStatus';
import { useGlanceTodos } from './botGlanceTodos';
import { useBotProfiles } from './botStore';
import { cloudRemoteBots, withoutShadowedBots } from './companionCloudPresentation';
import { useCompanionCloud } from './companionCloudStore';
import {
  claimTodoBoardReader,
  getTodoBoardEntries,
  isTodoBoardReader,
  setTodoBoardEntry,
  setTodoBoardRefresh,
  subscribeTodoBoard,
  todoBoardKey,
  todoBoardOpenCount,
  type TodoBoardTeammate,
} from './teammateTodoBoard';
import { useRemoteBots } from './useRemoteBots';

/** 本机未归档的伙伴在前，别的电脑上的伙伴随后（云端伙伴只列它主力电脑上的那份）。 */
export function useTodoBoardTeammates(): TodoBoardTeammate[] {
  const cloud = useCompanionCloud();
  const profiles = useBotProfiles();
  const remote = useRemoteBots();
  return useMemo(() => {
    const local = withoutShadowedBots(profiles, cloud)
      .filter((bot) => bot.status !== 'archived' && bot.status !== 'deleting')
      .map((bot): TodoBoardTeammate => ({
        key: todoBoardKey({ botId: bot.id }),
        botId: bot.id,
        name: bot.name,
        avatar: bot.avatar,
        avatarColor: bot.avatarColor,
        offline: false,
        route: `/bots/${encodeURIComponent(bot.id)}`,
      }));
    const others = cloudRemoteBots(cloud, remote).map((bot): TodoBoardTeammate => ({
      key: todoBoardKey({ botId: bot.id, deviceId: bot.deviceId }),
      botId: bot.id,
      deviceId: bot.deviceId,
      deviceName: bot.deviceName,
      name: bot.name,
      avatar: bot.avatar,
      avatarColor: bot.avatarColor,
      offline: isBotKnownOffline(bot.online, bot.connectionKnown),
      route: `/bots/remote/${encodeURIComponent(bot.deviceId)}/${encodeURIComponent(bot.id)}`,
    }));
    return [...local, ...others];
  }, [cloud, profiles, remote]);
}

export function useTodoBoardEntries() {
  return useSyncExternalStore(subscribeTodoBoard, getTodoBoardEntries, getTodoBoardEntries);
}

/** 读一位伙伴的待办写进共用暂存；同一位伙伴有多处挂着时只有一处真正去读。 */
function TodoBoardSource({ teammate }: { teammate: TodoBoardTeammate }) {
  const { key, botId, deviceId, offline } = teammate;
  const [token] = useState(() => Symbol(key));
  useEffect(() => claimTodoBoardReader(key, token), [key, token]);
  const reader = useSyncExternalStore(subscribeTodoBoard, () => isTodoBoardReader(key, token), () => false);
  const host = useMemo(() => ({ botId, deviceId }), [botId, deviceId]);
  // 那台电脑离线时不去读：读不到，只会白白排队。上次读到的仍留在暂存里置灰显示。
  const todos = useGlanceTodos(host, reader && !offline, { later: true, dailyCheck: false });
  const { loaded, failed, refresh } = todos;
  useEffect(() => {
    if (!reader || !loaded) return;
    setTodoBoardEntry(key, getDataOwnerGeneration(), failed ? { failed: true } : { todos: todos.todos, failed: false });
  }, [reader, loaded, failed, todos.todos, key]);
  useEffect(() => {
    if (!reader) return;
    setTodoBoardRefresh(key, () => void refresh());
    return () => setTodoBoardRefresh(key, null);
  }, [reader, key, refresh]);
  return null;
}

export function TodoBoardSources({ teammates }: { teammates: readonly TodoBoardTeammate[] }) {
  return (
    <>
      {teammates.map((teammate) => (
        <TodoBoardSource key={teammate.key} teammate={teammate} />
      ))}
    </>
  );
}

/**
 * 侧栏「待办」入口上的数：本机伙伴随时读（本机宿主，不走网络）；别的电脑上的伙伴只在打开
 * 待办页时经 device-link 去读，入口沿用那次读到的，不为一个数常驻拉取别的电脑。
 */
export function useTodoBoardOpenCount(): number {
  const teammates = useTodoBoardTeammates();
  const entries = useTodoBoardEntries();
  const personal = usePersonalTodoSnapshot();
  return todoBoardOpenCount(teammates, entries) + personal.items.filter(item => personalTodoIsOpen(item)).length;
}

export function TodoBoardLocalSources() {
  const teammates = useTodoBoardTeammates();
  const local = useMemo(() => teammates.filter((teammate) => !teammate.deviceId), [teammates]);
  return <TodoBoardSources teammates={local} />;
}
