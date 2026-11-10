/** 电脑页上的「待办」入口：只在这台电脑提供个人待办时出现，带上今天及已过期的未完成条数。 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { personalTodoDue, usePersonalTodos } from './usePersonalTodos';

export function PersonalTodoEntry({ deviceId, deviceName, enabled, onOpen }: {
  deviceId: string; deviceName: string; enabled: boolean; onOpen(): void;
}) {
  const { t } = useTranslation();
  const todos = usePersonalTodos({ deviceId, deviceName, enabled });
  const due = useMemo(() => todos.items.filter(todo => personalTodoDue(todo)).length, [todos.items]);
  if (todos.available !== true) return null;
  const label = t('devices.personalTodos.title');
  return <MainWindowActionButton action={{
    label: due > 0 ? `${label} ${due}` : label,
    accessibilityLabel: label,
    onPress: onOpen,
    testID: 'deviceDetail.personalTodos',
  }} />;
}
