/* Per-browser request ownership. No source text, key or results leave memory.
 * A response may render only while its input/output/selection snapshot matches.
 * Abort is best-effort; the snapshot check also rejects late mock/server replies.
 */
(function () {
  'use strict';
  var lanes = new Map();
  var sequence = 0;
  var version = 0;
  var fields = ['input', 'output', 'xbsOutput', 'aiRepairSource', 'aiProbeKeyword'];
  var watched = new Set(fields.concat(['aiRepairProblem', 'forceEnableAll', 'forceWeight', 'defaultWeight', 'legadoFile', 'xbsFile']));
  function capture() {
    return { version: version, values: fields.map(function (id) {
      var element = document.getElementById(id);
      return element ? element.value : '';
    }), full: window.lastFullJson || '' };
  }
  function matches(snapshot) {
    if (!snapshot || snapshot.version !== version || snapshot.full !== (window.lastFullJson || '')) return false;
    return fields.every(function (id, index) {
      var element = document.getElementById(id);
      return snapshot.values[index] === (element ? element.value : '');
    });
  }
  function updateButton() {
    var button = document.getElementById('cancelCurrentRequest');
    if (button) button.disabled = lanes.size === 0;
  }
  function cancel(lane) {
    var token = lanes.get(lane);
    if (!token) return;
    token.controller.abort();
    lanes.delete(lane);
    if (typeof token.onCancel === 'function') token.onCancel();
    updateButton();
  }
  function begin(lane, onCancel) {
    cancel(lane);
    var token = { lane: lane, id: ++sequence, snapshot: capture(), controller: new AbortController(), onCancel: onCancel };
    lanes.set(lane, token);
    updateButton();
    return token;
  }
  function owns(token) { return !!token && lanes.get(token.lane) === token; }
  function current(token) {
    return !!token && lanes.get(token.lane) === token && !token.controller.signal.aborted && matches(token.snapshot);
  }
  function finish(token) {
    if (token && lanes.get(token.lane) === token) lanes.delete(token.lane);
    updateButton();
  }
  function invalidate(reason) {
    var pending = lanes.size;
    version++;
    Array.from(lanes.keys()).forEach(cancel);
    document.dispatchEvent(new CustomEvent('booksource:invalidated', { detail: { reason: reason || 'source-changed', pending: pending } }));
  }
  function ready() {
    ['input', 'change'].forEach(function (eventName) {
      document.addEventListener(eventName, function (event) {
        if (watched.has(event.target && event.target.id)) invalidate('source-changed');
      }, true);
    });
    var button = document.getElementById('cancelCurrentRequest');
    if (button) button.addEventListener('click', function () {
      invalidate('cancelled');
      var status = document.getElementById('aiRepairStatus');
      if (status) status.textContent = '已取消等待，迟到的结果不会再显示或覆盖数据。服务端已发出的请求仍受超时限制。';
    });
    updateButton();
  }
  window.BooksourceRequests = { begin: begin, owns: owns, current: current, finish: finish, cancel: cancel, invalidate: invalidate, capture: capture, matches: matches };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
})();
