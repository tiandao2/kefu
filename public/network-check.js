(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const start = $('start'), copy = $('copy'), copyFull = $('copy-full'), briefBox = $('brief'), status = $('status'), summary = $('summary');
  const round = value => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
  const span = (end, begin) => Number.isFinite(end) && Number.isFinite(begin) && end >= begin ? round(end - begin) : null;
  const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const n = Math.floor(Math.random() * 16); return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
  const targets = [
    ['首页 HTML', '/'], ['页面样式', '/style.css'],
    ['页面脚本', '/app.js'], ['健康接口', '/healthz']
  ];
  const report = {
    version: 3, id, time: new Date().toISOString(),
    userAgent: navigator.userAgent,
    capabilities: {
      fetch: typeof window.fetch === 'function',
      abortController: typeof window.AbortController === 'function',
      abortSignalTimeout: !!window.AbortSignal && typeof window.AbortSignal.timeout === 'function',
      resourceTiming: typeof performance.getEntriesByName === 'function',
      secureContext: window.isSecureContext === true
    },
    networkHint: navigator.connection ? {
      effectiveType: navigator.connection.effectiveType,
      estimatedRttMs: navigator.connection.rtt,
      estimatedDownlinkMbps: navigator.connection.downlink
    } : null,
    note: '单位 ms；首字节包含此前各网络阶段，不应将它与 DNS/TCP/TLS 再相加。0 可能表示缓存、连接复用或浏览器未暴露该阶段。网络提示为浏览器估计，不是本次线路实测。此页不调用客服会话或 Telegram。',
    navigation: null, firstContentfulPaintMs: null, script: null, checks: []
  };
  function timing(entry) {
    if (!entry) return null;
    const secure = entry.secureConnectionStart > 0;
    return {
      dnsMs: span(entry.domainLookupEnd, entry.domainLookupStart),
      tcpMs: span(secure ? entry.secureConnectionStart : entry.connectEnd, entry.connectStart),
      tlsMs: secure ? span(entry.connectEnd, entry.secureConnectionStart) : null,
      beforeRequestMs: span(entry.requestStart, entry.startTime),
      responseWaitMs: entry.requestStart > 0 ? span(entry.responseStart, entry.requestStart) : null,
      firstByteMs: span(entry.responseStart, entry.startTime),
      downloadMs: span(entry.responseEnd, entry.responseStart),
      responseCompleteMs: span(entry.responseEnd, entry.startTime),
      protocol: entry.nextHopProtocol || null,
      transferredBytes: entry.transferSize,
      encodedBodyBytes: entry.encodedBodySize,
      decodedBodyBytes: entry.decodedBodySize
    };
  }
  function add(text) {
    const p = document.createElement('p'); p.textContent = text; summary.append(p);
  }
  function brief() {
    const ms = value => Number.isFinite(value) ? `${value}ms` : '未提供';
    const nav = report.navigation;
    const lines = [`检测 v${report.version} / ${report.id}`, `时间：${report.time}`];
    lines.push(nav ? `首屏：DNS ${ms(nav.dnsMs)}；TCP ${ms(nav.tcpMs)}；TLS ${ms(nav.tlsMs)}` : '首屏：浏览器未提供导航计时');
    lines.push(nav ? `首字节 ${ms(nav.firstByteMs)}；HTML完成 ${ms(nav.responseCompleteMs)}；页面load ${ms(nav.loadEventEndMs)}` : '首字节／HTML／load：未提供');
    lines.push(`首次绘制 ${ms(report.firstContentfulPaintMs)}；检测脚本 ${ms(report.script?.responseCompleteMs)}`);
    for (const [label, path] of targets) {
      const all = report.checks.filter(check => check.path === path), values = all.map(check => check.elapsedMs).filter(Number.isFinite);
      const failures = all.filter(check => !check.ok);
      const range = values.length ? `${ms(Math.min(...values))}–${ms(Math.max(...values))}` : '未检测';
      const error = failures.length ? `；失败：${failures[0].error || `HTTP ${failures[0].status}`} ${failures[0].phase || ''} ${failures[0].errorMessage || ''}` : '';
      lines.push(`${label}：${all.length - failures.length}/${all.length}成功，${range}${error}`);
    }
    lines.push(`浏览器：${report.userAgent}`);
    lines.push('以上是检测页首屏；后续请求可能复用连接。请补充城市、运营商、Wi-Fi／流量及白屏秒数。');
    return lines.join('\n');
  }
  function save() {
    const nav = performance.getEntriesByType('navigation')[0];
    report.navigation = nav ? {
      ...timing(nav), type: nav.type, redirectCount: nav.redirectCount,
      domContentLoadedMs: nav.domContentLoadedEventEnd > 0 ? round(nav.domContentLoadedEventEnd) : null,
      loadEventEndMs: nav.loadEventEnd > 0 ? round(nav.loadEventEnd) : null
    } : null;
    report.firstContentfulPaintMs = round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime);
    const script = performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/network-check.js');
    report.script = timing(script);
    report.brief = brief();
    if (briefBox) briefBox.value = report.brief;
    $('report').value = JSON.stringify(report, null, 2);
  }
  async function check([label, path], run) {
    const url = new URL(path, location.origin);
    url.searchParams.set('speed_check', id);
    url.searchParams.set('round', String(run));
    const begun = performance.now();
    let state, timer, response, phase = 'setup', fetchInvoked = false;
    const controller = typeof window.AbortController === 'function' ? new AbortController() : null;
    try {
      if (typeof window.fetch !== 'function') {
        const error = new Error('当前浏览器不支持 fetch，请更换系统浏览器检测。');
        error.name = 'UnsupportedBrowser'; throw error;
      }
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error('超过 15 秒未完成'); error.name = 'TimeoutError';
          reject(error); if (controller) controller.abort();
        }, 15000);
      });
      const transfer = (async () => {
        const options = {cache: 'no-store', credentials: 'omit'};
        if (controller) options.signal = controller.signal;
        phase = 'request'; fetchInvoked = true;
        response = await fetch(url, options);
        phase = 'response'; return response.text();
      })();
      const body = await Promise.race([transfer, timeout]);
      const valid = path !== '/healthz' || (() => {
        try { return JSON.parse(body).ok === true; } catch { return false; }
      })();
      state = {label, path, run, status: response.status, ok: response.ok && valid,
        bodyBytes: typeof Blob === 'function' ? new Blob([body]).size : null};
    } catch (error) {
      state = {label, path, run, ok: false, error: String(error.name),
        errorMessage: String(error.message || error).slice(0, 240), phase,
        fetchInvoked, status: response ? response.status : null};
    } finally {
      clearTimeout(timer);
    }
    state.elapsedMs = round(performance.now() - begun);
    await new Promise(resolve => setTimeout(resolve, 0));
    const entries = typeof performance.getEntriesByName === 'function' ? performance.getEntriesByName(url.href) : [];
    state.network = timing(entries[entries.length - 1]);
    add(`第 ${run} 轮 · ${label}：${state.ok ? '正常' : '失败'}，${state.elapsedMs} ms${state.status ? `，HTTP ${state.status}` : ''}`);
    return state;
  }
  async function run() {
    start.disabled = true; copy.disabled = true; if (copyFull) copyFull.disabled = true;
    summary.replaceChildren(); report.checks = [];
    try {
      save();
      add('检测版本：3；点击“复制简短结果”，首屏时间会一起复制。');
      if (!report.capabilities.abortSignalTimeout) add('浏览器缺少旧检测程序使用的方法；新版已使用兼容的超时处理。');
      if (report.navigation) add(`本次检测页首字节：${report.navigation.firstByteMs} ms；HTML 接收完成：${report.navigation.responseCompleteMs} ms。`);
      for (let n = 1; n <= 3; n++) {
        status.textContent = `正在检测第 ${n}/3 轮，请保持本页在前台…`;
        const values = await Promise.all(targets.map(target => check(target, n)));
        report.checks.push(...values); save();
      }
      status.textContent = '检测完成。请点击“复制简短结果”，并补充所在城市、运营商及 Wi-Fi／手机流量。';
      add('本页各资源请求使用当前连接；不能将这些请求的快速结果直接当作首次打开客服页也很快。');
    } catch (error) {
      status.textContent = '检测未完整结束，请复制已有结果。';
      report.error = String(error.name); report.errorMessage = String(error.message || error).slice(0, 240); save();
    } finally { start.disabled = false; copy.disabled = false; if (copyFull) copyFull.disabled = false; }
  }
  start.addEventListener('click', run);
  async function copyResult(full) {
    save();
    const text = full ? $('report').value : report.brief;
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = '已复制，请发给维护人员，并说明城市、运营商和使用的网络。';
    } catch {
      const box = full || !briefBox ? $('report') : briefBox;
      if (box.closest('details')) box.closest('details').open = true;
      box.value = text;
      box.focus(); box.select(); box.setSelectionRange(0, box.value.length);
      status.textContent = '浏览器未允许自动复制；结果已选中，请长按复制。';
    }
  }
  copy.addEventListener('click', () => copyResult(false));
  if (copyFull) copyFull.addEventListener('click', () => copyResult(true));
  start.disabled = false; copy.disabled = false; if (copyFull) copyFull.disabled = false;
  status.textContent = '检测程序已就绪。点击“开始检测”，约需数秒；网络超时最多约 45 秒。';
  save();
  window.addEventListener('load', () => setTimeout(save, 0), {once: true});
})();
