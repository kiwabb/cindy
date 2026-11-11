/**
 * 电脑上的个人待办：未完成 / 稍后 / 已完成（折叠）三组，点一行编辑（标题、备注、日期、完成或重开、删除），
 * 右上角新建。数据与写入都在这台电脑上，手机只显示与提交；电脑不提供时直接退回。
 */
import { useIsFocused, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, ChevronUp, Circle, ListChecks } from 'lucide-react-native';
import { todoLocalDate } from '@cindy/maker-shared/teammate-todo';
import { useAuth } from '@/auth/AuthContext';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton } from '@/components/MobilePrimitives';
import { SimpleStackHeader, simpleScreenSafeAreaEdges } from '@/platform/chrome';
import {
  groupPersonalTodos,
  newCreationRequestId,
  personalTodoDue,
  personalTodoErrorKind,
  usePersonalTodos,
  type PersonalTodoItem,
} from '@/session/usePersonalTodos';
import { personalTodoTagColor, personalTodoTagLabel, priorityRingColor, RING_TINT_ALPHA } from '@/session/personalTodoVisuals';
import { goBackGuarded } from '@/utils/backGuard';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale, useTheme, useThemedStyles, type ThemeColors } from '@/theme';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const validDate = (value: string) => DATE_RE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export default function PersonalTodosScreen() {
  const { accountGeneration } = useAuth();
  const { deviceId, deviceName } = useLocalSearchParams<{ deviceId: string; deviceName?: string }>();
  return <PersonalTodosContent key={`${accountGeneration}:${deviceId}`} deviceId={deviceId} deviceName={deviceName ?? ''} />;
}

type Editing = { kind: 'new' } | { kind: 'edit'; id: string } | null;

function PersonalTodosContent({ deviceId, deviceName }: { deviceId: string; deviceName: string }) {
  const { t } = useTranslation();
  const tr = (key: string) => t(`devices.personalTodos.${key}`);
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const focused = useIsFocused();
  const todos = usePersonalTodos({ deviceId, deviceName, enabled: focused });
  const [editing, setEditing] = useState<Editing>(null);
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => groupPersonalTodos(todos.items), [todos.items]);
  const back = useCallback(() => goBackGuarded(router), [router]);
  // A computer that does not offer personal todos (older desktop) has nothing to show here.
  useEffect(() => { if (todos.available === false) back(); }, [back, todos.available]);

  const fail = (cause: unknown) => {
    const kind = personalTodoErrorKind(cause);
    setError(kind === 'conflict' ? tr('conflict') : kind === 'gone' ? tr('gone') : tr('saveFailed'));
  };
  const toggle = async (todo: PersonalTodoItem) => {
    setError(null);
    try {
      await todos.update({ id: todo.id, expectedRevision: todo.revision, operation: todo.status === 'open' ? 'complete' : 'reopen' });
    } catch (cause) { fail(cause); }
  };

  const edited = editing?.kind === 'edit' ? todos.items.find(item => item.id === editing.id) : undefined;
  if (editing && (editing.kind === 'new' || edited)) {
    return <TodoEditor key={editing.kind === 'edit' ? editing.id : 'new'} todo={edited} update={todos.update}
      onDone={() => setEditing(null)} onBack={() => setEditing(null)} />;
  }

  const row = (todo: PersonalTodoItem) => {
    const due = personalTodoDue(todo);
    // A done row drops the priority color; a tag the catalog no longer has is already absent from `tags`.
    const ring = todo.status === 'open' ? priorityRingColor(todo.priority, colors) : null;
    const tag = todo.tags[0];
    const stepsTotal = todo.subtasks.length;
    const stepsDone = todo.subtasks.filter(step => step.done).length;
    return <View key={todo.id} style={styles.row}>
      <Pressable accessibilityRole="button" accessibilityLabel={todo.status === 'open' ? tr('complete') : tr('reopen')}
        hitSlop={8} onPress={() => void toggle(todo)} style={styles.check} testID="personalTodos.toggle">
        {todo.status === 'done'
          ? <Check size={iconSize.lg} strokeWidth={iconStroke.medium} color={colors.textTertiary} />
          : ring
            ? <Circle size={iconSize.lg} strokeWidth={iconStroke.medium} color={ring} fill={`${ring}${RING_TINT_ALPHA}`} testID={`personalTodos.ring.${todo.priority}`} />
            : <Circle size={iconSize.lg} strokeWidth={iconStroke.regular} color={colors.textSecondary} />}
      </Pressable>
      <Pressable accessibilityRole="button" onPress={() => { setError(null); setEditing({ kind: 'edit', id: todo.id }); }}
        style={({ pressed }) => [styles.rowBody, pressed && styles.pressed]} testID="personalTodos.row">
        <Text numberOfLines={2} style={[styles.rowTitle, todo.status === 'done' && styles.rowTitleDone]}>{todo.title}</Text>
        {todo.deadline || tag || stepsTotal > 0 ? <View style={styles.meta}>
          {due ? <View style={styles.dueDot} /> : null}
          {todo.deadline ? <Text style={styles.rowMeta}>{todo.deadline.date}</Text> : null}
          {stepsTotal > 0 ? <View style={styles.steps} testID="personalTodos.steps">
            <ListChecks size={iconSize.sm} strokeWidth={iconStroke.regular} color={colors.textTertiary} />
            <Text style={styles.rowMeta}>{`${stepsDone}/${stepsTotal}`}</Text>
          </View> : null}
          {tag ? <View testID="personalTodos.tagDot" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
            style={[styles.tagDot, { backgroundColor: personalTodoTagColor(tag.color, colors) }]} /> : null}
          {tag ? <Text numberOfLines={1} style={[styles.rowMeta, styles.tagName]} testID="personalTodos.tagName">{personalTodoTagLabel(tag, t)}</Text> : null}
        </View> : null}
      </Pressable>
    </View>;
  };
  const section = (label: string, items: PersonalTodoItem[]) => items.length === 0 ? null : <View style={styles.section}>
    <Text style={styles.sectionLabel}>{label}</Text>
    <View style={styles.card}>{items.map(row)}</View>
  </View>;

  return <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.screen} testID="personalTodos.screen">
    <SimpleStackHeader title={tr('title')} backTestID="personalTodos.back" onBack={back}
      action={{ label: tr('add'), onPress: () => { setError(null); setEditing({ kind: 'new' }); }, testID: 'personalTodos.add' }} />
    <ScrollView contentContainerStyle={styles.content}>
      {todos.failed ? <Pressable accessibilityRole="button" onPress={() => void todos.refresh()} testID="personalTodos.retry">
        <Text style={styles.error}>{tr('loadFailed')}</Text>
      </Pressable> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error} testID="personalTodos.error">{error}</Text> : null}
      {section(tr('open'), groups.open)}
      {section(tr('later'), groups.later)}
      {groups.done.length > 0 ? <View style={styles.section}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: showDone }} onPress={() => setShowDone(value => !value)}
          style={styles.foldRow} testID="personalTodos.done">
          <Text style={styles.sectionLabel}>{`${tr('done')} ${groups.done.length}`}</Text>
          {showDone ? <ChevronUp size={iconSize.lg} strokeWidth={iconStroke.regular} color={colors.textTertiary} />
            : <ChevronDown size={iconSize.lg} strokeWidth={iconStroke.regular} color={colors.textTertiary} />}
        </Pressable>
        {showDone ? <View style={styles.card}>{groups.done.map(row)}</View> : null}
      </View> : null}
    </ScrollView>
  </SafeAreaView>;
}

function TodoEditor({ todo, update, onDone, onBack }: {
  todo?: PersonalTodoItem; update: ReturnType<typeof usePersonalTodos>['update']; onDone(): void; onBack(): void;
}) {
  const { t } = useTranslation();
  const tr = (key: string) => t(`devices.personalTodos.${key}`);
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const [title, setTitle] = useState(todo?.title ?? '');
  const [notes, setNotes] = useState(todo?.notes ?? '');
  const [date, setDate] = useState(todo?.deadline?.date ?? '');
  const [requestId] = useState(newCreationRequestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dateOk = date === '' || validDate(date);
  const canSave = title.trim().length > 0 && dateOk && !busy;
  const pickDay = (offsetDays: number) => setDate(todoLocalDate(new Date(Date.now() + offsetDays * 86_400_000), zone()));

  const run = async (input: Parameters<typeof update>[0], close = true) => {
    setBusy(true);
    setError(null);
    try {
      await update(input);
      if (close) onDone();
    } catch (cause) {
      const kind = personalTodoErrorKind(cause);
      setError(kind === 'conflict' ? tr('conflict') : kind === 'gone' ? tr('gone') : tr('saveFailed'));
      // The latest copy is re-read by the hook; a conflict returns to the list so nothing stale is edited.
      if (kind !== 'failed') onDone();
    } finally { setBusy(false); }
  };
  const save = () => {
    const unchangedDate = (todo?.deadline?.date ?? '') === date;
    void run({
      ...(todo ? { id: todo.id, expectedRevision: todo.revision } : { creationRequestId: requestId }),
      title: title.trim(),
      notes,
      ...(unchangedDate ? {} : { deadline: date ? { kind: 'date' as const, date, timeZone: zone() } : null }),
    });
  };
  const remove = () => {
    if (!todo) return;
    Alert.alert(tr('deleteConfirm'), undefined, [
      { text: t('devices.common.cancel'), style: 'cancel' },
      { text: t('devices.common.delete'), style: 'destructive',
        onPress: () => void run({ id: todo.id, expectedRevision: todo.revision, operation: 'delete' }) },
    ]);
  };

  return <SafeAreaView edges={simpleScreenSafeAreaEdges()} style={styles.screen} testID="personalTodos.editor">
    <SimpleStackHeader title={tr('title')} backTestID="personalTodos.editor.back" onBack={onBack} />
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.sectionLabel}>{tr('titleField')}</Text>
      <TextInput accessibilityLabel={tr('titleField')} value={title} onChangeText={setTitle} maxLength={200}
        placeholderTextColor={colors.textPlaceholder} style={styles.input} testID="personalTodos.title" />
      <Text style={styles.sectionLabel}>{tr('notesField')}</Text>
      <TextInput accessibilityLabel={tr('notesField')} value={notes} onChangeText={setNotes} multiline
        placeholderTextColor={colors.textPlaceholder} style={[styles.input, styles.notes]} testID="personalTodos.notes" />
      <Text style={styles.sectionLabel}>{tr('dateField')}</Text>
      <TextInput accessibilityLabel={tr('dateField')} value={date} onChangeText={setDate} maxLength={10} placeholder="YYYY-MM-DD"
        autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation"
        placeholderTextColor={colors.textPlaceholder} style={[styles.input, !dateOk && styles.inputInvalid]} testID="personalTodos.date" />
      <View style={styles.chips}>
        {[[tr('today'), () => pickDay(0)], [tr('tomorrow'), () => pickDay(1)], [tr('noDate'), () => setDate('')]].map(([label, onPress]) =>
          <Pressable key={label as string} accessibilityRole="button" onPress={onPress as () => void}
            style={({ pressed }) => [styles.chip, pressed && styles.pressed]}>
            <Text style={styles.chipText}>{label as string}</Text>
          </Pressable>)}
      </View>
      {error ? <Text accessibilityRole="alert" style={styles.error} testID="personalTodos.editor.error">{error}</Text> : null}
      <View style={styles.actions}>
        <MainWindowActionButton action={{ label: t('devices.common.save'), tone: 'primary', busy, disabled: !canSave, onPress: save, testID: 'personalTodos.save' }} />
        {todo ? <MainWindowActionButton action={{ label: todo.status === 'open' ? tr('complete') : tr('reopen'), disabled: busy,
          onPress: () => void run({ id: todo.id, expectedRevision: todo.revision, operation: todo.status === 'open' ? 'complete' : 'reopen' }),
          testID: 'personalTodos.toggleEditor' }} /> : null}
        {todo ? <MainWindowActionButton action={{ label: t('devices.common.delete'), tone: 'danger', disabled: busy, onPress: remove, testID: 'personalTodos.delete' }} /> : null}
      </View>
    </ScrollView>
  </SafeAreaView>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  screen: { backgroundColor: colors.surface, flex: 1 },
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.sm },
  section: { marginBottom: spacing.lg },
  sectionLabel: { color: colors.textTertiary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.semibold, paddingBottom: spacing.sm },
  card: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.container, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 48, paddingHorizontal: spacing.md },
  check: { width: 32, height: 44, alignItems: 'center', justifyContent: 'center' },
  rowBody: { flex: 1, minWidth: 0, paddingVertical: spacing.md - 2, gap: 2 },
  pressed: { opacity: 0.6 },
  rowTitle: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body, fontWeight: fontWeight.medium },
  rowTitleDone: { color: colors.textSecondary, fontWeight: fontWeight.regular },
  meta: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 },
  steps: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  rowMeta: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  tagDot: { width: 8, height: 8, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  tagName: { flexShrink: 1 },
  dueDot: { width: 6, height: 6, borderRadius: radius.pill, backgroundColor: colors.statusError },
  foldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 44 },
  error: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular, paddingVertical: spacing.sm },
  input: { minHeight: 44, borderRadius: radius.container, paddingHorizontal: spacing.md, fontSize: typeScale.bodySmall, color: colors.textPrimary, backgroundColor: colors.surfaceElevated, borderWidth: 1, borderColor: colors.border },
  inputInvalid: { borderColor: colors.statusError },
  notes: { minHeight: 96, paddingTop: spacing.md, textAlignVertical: 'top', lineHeight: lineHeight.bodySmall },
  chips: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.sm },
  chip: { minHeight: 36, justifyContent: 'center', paddingHorizontal: spacing.md, borderRadius: radius.pill, backgroundColor: colors.surfaceChip },
  chipText: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption, fontWeight: fontWeight.regular },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.lg },
});
