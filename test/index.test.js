import assert from 'node:assert/strict';
import { test } from 'node:test';

import { interruptedTurnOf, quotaState, readWorkspaceIndex } from '../lib/detect.js';

const start = (turn) => ({ type: 'turn/start', data: { turn } });
const end = (turn, kind) => ({ type: 'turn/end', data: { turn, reason: { kind } } });
const other = (type) => ({ type, data: {} });

test('interruptedTurnOf: 空数组/非数组返回 undefined', () => {
  assert.equal(interruptedTurnOf([]), undefined);
  assert.equal(interruptedTurnOf(undefined), undefined);
  assert.equal(interruptedTurnOf(null), undefined);
});

test('interruptedTurnOf: 正常跑完（completed）不算中断', () => {
  assert.equal(interruptedTurnOf([start(1), other('message'), end(1, 'completed')]), undefined);
});

test('interruptedTurnOf: 用户手动停止（user）不算中断', () => {
  assert.equal(interruptedTurnOf([start(2), end(2, 'user')]), undefined);
});

test('interruptedTurnOf: 最后事件是 turn/start（没有 turn/end）→ open', () => {
  assert.deepEqual(interruptedTurnOf([start(3), other('message')]), { turn: 3, kind: 'open' });
});

test('interruptedTurnOf: 最后一个 turn/end 是 interrupted → interrupted', () => {
  assert.deepEqual(interruptedTurnOf([start(4), end(4, 'interrupted')]), { turn: 4, kind: 'interrupted' });
});

test('interruptedTurnOf: interrupted 之后又有新 turn/start → 取新的一轮 open', () => {
  const events = [start(5), end(5, 'interrupted'), start(6)];
  assert.deepEqual(interruptedTurnOf(events), { turn: 6, kind: 'open' });
});

test('interruptedTurnOf: interrupted 之后已完成新一轮 → undefined', () => {
  const events = [start(7), end(7, 'interrupted'), start(8), end(8, 'completed')];
  assert.equal(interruptedTurnOf(events), undefined);
});

test('interruptedTurnOf: 只有一轮 start+end completed，后面全是非轮次事件 → undefined', () => {
  const events = [start(9), end(9, 'completed'), other('message'), other('tool/result')];
  assert.equal(interruptedTurnOf(events), undefined);
});

test('interruptedTurnOf: 缺 turn 字段时回落 null，不抛错', () => {
  assert.deepEqual(interruptedTurnOf([{ type: 'turn/start', data: {} }]), { turn: null, kind: 'open' });
  assert.deepEqual(interruptedTurnOf([{ type: 'turn/end', data: { reason: { kind: 'interrupted' } } }]),
    { turn: null, kind: 'interrupted' });
});

test('interruptedTurnOf: 容忍 data 缺失的事件', () => {
  assert.deepEqual(interruptedTurnOf([{ type: 'turn/start' }]), { turn: null, kind: 'open' });
});

const NOW = 1_700_000_000_000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

test('quotaState: 没有历史记录 → 放行', () => {
  assert.equal(quotaState(undefined, NOW, 3, 30).ok, true);
  assert.equal(quotaState([], NOW, 3, 30).ok, true);
});

test('quotaState: 24h 内达到次数上限 → quota', () => {
  const history = [NOW - 1 * HOUR, NOW - 2 * HOUR, NOW - 3 * HOUR];
  const v = quotaState(history, NOW, 3, 1);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'quota');
  assert.equal(v.recent, 3);
});

test('quotaState: 24h 外的不计入', () => {
  const history = [NOW - 30 * HOUR, NOW - 40 * HOUR];
  assert.equal(quotaState(history, NOW, 3, 30).ok, true);
});

test('quotaState: 冷却期内 → cooldown', () => {
  assert.equal(quotaState([NOW - 5 * MIN], NOW, 3, 30).reason, 'cooldown');
});

test('quotaState: 超出冷却期的历史 → 放行', () => {
  assert.equal(quotaState([NOW - 31 * MIN], NOW, 3, 30).ok, true);
});

test('quotaState: 非数字条目被忽略', () => {
  assert.equal(quotaState([null, 'x', {}, NOW - 31 * MIN], NOW, 3, 30).ok, true);
});

test('readWorkspaceIndex: 抽出在册与归档会话', () => {
  const doc = {
    tables: { workspaces: { a: { sessionIds: ['s1', 's2'] }, b: { sessionIds: ['s3'] } } },
    global: { archivedSessionIds: ['s2'] },
  };
  const idx = readWorkspaceIndex(doc);
  assert.deepEqual([...idx.members].sort(), ['s1', 's2', 's3']);
  assert.deepEqual([...idx.archived], ['s2']);
});

test('readWorkspaceIndex: 文档结构缺失时 members 为 undefined（表示"全部都是候选"）', () => {
  assert.equal(readWorkspaceIndex(undefined).members, undefined);
  assert.equal(readWorkspaceIndex({}).members, undefined);
  assert.deepEqual([...readWorkspaceIndex({}).archived], []);
});

test('readWorkspaceIndex: 空的 tables.workspaces 也回落 undefined', () => {
  assert.equal(readWorkspaceIndex({ tables: { workspaces: {} } }).members, undefined);
});

test('readWorkspaceIndex: 数字 id 被转成字符串', () => {
  const doc = { tables: { workspaces: { a: { sessionIds: [1, 2] } } } };
  assert.deepEqual([...readWorkspaceIndex(doc).members].sort(), ['1', '2']);
});
