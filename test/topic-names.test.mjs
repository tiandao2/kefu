import {test} from 'node:test';
import assert from 'node:assert/strict';
import {compactRegion, topicTitle, upgradeLegacyTopicTitle, topicRenamePlan} from '../topic-names.mjs';

test('topic names shorten administrative labels without losing place names', () => {
  for (const [before, after] of [
    ['河北省石家庄市', '河北石家庄'], ['广东省中山市', '广东中山'],
    ['上海市上海市', '上海'], ['北京市北京市', '北京'], ['天津市', '天津'],
    ['广西壮族自治区南宁市', '广西南宁'], ['广西南宁市', '广西南宁'],
    ['新疆维吾尔自治区乌鲁木齐市', '新疆乌鲁木齐'], ['内蒙古自治区呼和浩特市', '内蒙古呼和浩特'],
    ['宁夏回族自治区银川市', '宁夏银川'], ['西藏自治区拉萨市', '西藏拉萨'],
    ['香港特别行政区', '香港'], ['湖北省沙市区', '湖北沙市区'],
    ['CambodiaPhnom Penh', 'CambodiaPhnom Penh'], ['', '未知地区']
  ]) assert.equal(compactRegion(before), after);
  assert.equal(topicTitle(12, '河北省石家庄市'), '12-河北石家庄');
  assert.equal(topicTitle(1, ''), '1-未知地区');
});

test('existing rename plan targets matching legacy numbers and preserves custom or modern titles', () => {
  const rows = [
    {number: 12, topic_id: 100, title: '河北省石家庄市-000012'},
    {number: 13, topic_id: 101, title: '老客户备注'},
    {number: 14, topic_id: 102, title: '河北省石家庄市-000012'},
    {number: 15, topic_id: 103, title: '15-广东中山'},
    {number: 16, topic_id: null, title: '广东省中山市-000016'}
  ];
  assert.deepEqual(topicRenamePlan(rows), [{number: 12, topicId: 100, from: rows[0].title, to: '12-河北石家庄'}]);
  assert.equal(upgradeLegacyTopicTitle(16, rows[4].title), '16-广东中山');
  assert.deepEqual(topicRenamePlan(rows.map(v => ({...v, title: upgradeLegacyTopicTitle(v.number, v.title)}))), []);
});
