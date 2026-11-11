/**
 * 测试价值
 * - 生产入口与可观察结果：allowlist 放行 maker:shared-datasets:v1 并带长超时；
 *   parseSharedDatasetsRequest / parseSharedDatasetsSnapshotReply 对线上帧的边界判定。
 * - 规则依据：docs/dev-rules/protocol-compatibility.md（新通道必须登记 allowlist、
 *   未知/畸形参数 fail-closed）；docs/shared-datasets-plan.md §5.2。
 * - 现有覆盖缺口：新通道，allowlist.test 与 setupSnapshot.test 均不涉及。
 * - 最小失败输入：source 与 sequence 不合法的 submit；空数据集的空游标快照。
 * - tier：unit。
 */
import { describe, expect, it } from 'vitest';

import { INVOKE_TIMEOUT_OVERRIDES_MS, REMOTE_INVOKE_ALLOWLIST } from '../allowlist.js';
import {
  SHARED_DATASETS_CHANNEL,
  SHARED_DATASETS_TIMEOUT_MS,
  parseSharedDatasetsRequest,
  parseSharedDatasetsSnapshotReply,
} from '../sharedDatasets.js';

describe('shared datasets channel', () => {
  it('is remotely invocable and gets the long snapshot timeout', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(SHARED_DATASETS_CHANNEL)).toBe(true);
    expect(INVOKE_TIMEOUT_OVERRIDES_MS[SHARED_DATASETS_CHANNEL]).toBe(SHARED_DATASETS_TIMEOUT_MS);
  });

  it.each([
    [{ action: 'caps' }, true],
    [{ action: 'snapshot', dataset: 'personal-todos', cursor: 'abc' }, true],
    [{ action: 'submit', dataset: 'personal-todos', source: 'replica:dev-1', sequence: 3, update: { title: 'x' } }, true],
    [{ action: 'handover', dataset: 'personal-todos', newHomeDeviceId: 'dev-2', homeEpoch: 2 }, true],
    [{ action: 'submit', dataset: 'personal-todos', source: 'dev-1', sequence: 3, update: {} }, false],
    [{ action: 'submit', dataset: 'personal-todos', source: 'replica:dev-1', sequence: 0, update: {} }, false],
    [{ action: 'submit', dataset: 'personal-todos', source: 'replica:dev-1', sequence: 1, update: [] }, false],
    [{ action: 'snapshot', dataset: '../etc' }, false],
    [{ action: 'delete', dataset: 'personal-todos' }, false],
    ['caps', false],
  ])('parses %j → accepted=%s', (value, accepted) => {
    if (accepted) expect(parseSharedDatasetsRequest(value)).toMatchObject({ action: (value as { action: string }).action });
    else expect(() => parseSharedDatasetsRequest(value)).toThrow('SHARED_DATASETS_INVALID');
  });

  it('reads the three snapshot answers, including the empty fingerprint of an empty dataset', () => {
    expect(parseSharedDatasetsSnapshotReply({ cursor: '', items: [] })).toEqual({ cursor: '', items: [], extras: undefined });
    expect(parseSharedDatasetsSnapshotReply({ cursor: 'c', unchanged: true })).toEqual({ cursor: 'c', unchanged: true });
    expect(parseSharedDatasetsSnapshotReply({ notHome: true, homeDeviceId: 'd', homeEpoch: 2 })).toEqual({
      notHome: true,
      homeDeviceId: 'd',
      homeEpoch: 2,
    });
    expect(parseSharedDatasetsSnapshotReply({ items: [] })).toBeNull();
  });
});
