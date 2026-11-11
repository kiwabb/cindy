import { usePersonalTodoSnapshot } from './usePersonalTodoSnapshot';
import { personalTodoIsOpen } from './personalTodoCache';

/** 侧栏「待办」入口上的数：个人待办里进行中的。 */
export function useTodoBoardOpenCount(): number {
  const personal = usePersonalTodoSnapshot();
  return personal.items.filter((item) => personalTodoIsOpen(item)).length;
}
