/**
 * hook_main.js —— 运行在 MAIN world（页面自身上下文）
 * 拦截小红书评论相关 API 的 fetch/XHR 响应，把原始 JSON 通过 postMessage
 * 转发给隔离世界里的 content.js 做对话链解析。
 * 不改写任何请求，只读旁观，不触发额外网络调用。
 */
(function () {
  'use strict';
  if (window.__xhsTracerHookInstalled) return;
  window.__xhsTracerHookInstalled = true;

  // 环形缓冲：方便在 DevTools 控制台排查（window.__xhsTracerRaw）
  window.__xhsTracerRaw = [];

  function forward(url, json) {
    try {
      window.__xhsTracerRaw.push({ url: String(url), json: json, t: Date.now() });
      if (window.__xhsTracerRaw.length > 30) window.__xhsTracerRaw.shift();
      window.postMessage(
        { source: 'xhs-thread-tracer', type: 'comments', payload: { url: String(url), json: json } },
        '*'
      );
    } catch (e) { /* ignore */ }
  }

  function isCommentApi(url) {
    return typeof url === 'string' && url.includes('/api/sns/web/v2/comment');
  }

  // ---- fetch hook ----
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const url =
          typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (isCommentApi(url)) {
          res.clone().json().then((json) => forward(url, json)).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return res;
    };
  }

  // ---- XHR hook ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xhsTracerUrl = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    if (isCommentApi(xhr.__xhsTracerUrl)) {
      xhr.addEventListener('load', function () {
        try {
          forward(xhr.__xhsTracerUrl, JSON.parse(xhr.responseText));
        } catch (e) { /* ignore */ }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
