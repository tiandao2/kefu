// Keep place names intact: shorten administrative suffixes, not every 市 in a name.
const autonomous = [
  ['广西壮族自治区', '广西'], ['宁夏回族自治区', '宁夏'],
  ['新疆维吾尔自治区', '新疆'], ['内蒙古自治区', '内蒙古'], ['西藏自治区', '西藏'],
  ['香港特别行政区', '香港'], ['澳门特别行政区', '澳门']
];

export function compactRegion(value) {
  let text = String(value || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 64);
  for (const [full, short] of autonomous) {
    if (text.startsWith(full)) { text = short + text.slice(full.length); break; }
  }
  text = text.replace(/^([^省]+)省/, '$1');
  const municipality = /^(北京|天津|上海|重庆)市?/.exec(text);
  if (municipality) {
    let rest = text.slice(municipality[0].length);
    if (rest.startsWith(municipality[1])) rest = rest.slice(municipality[1].length).replace(/^市/, '');
    text = municipality[1] + rest;
  }
  return text.replace(/市$/, '') || '未知地区';
}

export function topicTitle(number, region) {
  const n = Number(number);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Invalid visitor number');
  return `${n}-${compactRegion(region)}`;
}

export function upgradeLegacyTopicTitle(number, title) {
  const old = String(title || '');
  const suffix = `-${String(number).padStart(6, '0')}`;
  if (!old.endsWith(suffix) || old.length === suffix.length) return old;
  return topicTitle(number, old.slice(0, -suffix.length));
}

export function topicRenamePlan(visitors) {
  return visitors.flatMap(v => {
    const name = upgradeLegacyTopicTitle(v.number, v.title);
    return v.topic_id && v.title && name !== v.title
      ? [{ number: v.number, topicId: v.topic_id, from: v.title, to: name }] : [];
  });
}
