/* EduRankAI Virtual Labs — embed SDK.
 * An institution drops this into its LMS / virtual infra:
 *
 *   <script src="https://edurankai.in/era-labs-embed.js"></script>
 *   <div data-era-lab="quantum-lab" data-height="640"></div>
 *
 * Every matching element is replaced with a responsive, sandboxed iframe of the
 * lab in chromeless embed mode. Lab -> host events arrive via postMessage
 * ({ source:"era-lab", type, slug }) so the host can forward progress/completion
 * to its own LRS / gradebook. No dependencies. Self-hosted, offline-capable.
 */
(function () {
  'use strict';
  var ORIGIN = (function () {
    try { var s = document.currentScript && document.currentScript.src; return s ? new URL(s).origin : 'https://edurankai.in'; }
    catch (e) { return 'https://edurankai.in'; }
  })();

  function mount(el) {
    if (el.getAttribute('data-era-mounted')) return;
    var slug = el.getAttribute('data-era-lab');
    if (!slug) return;
    var height = el.getAttribute('data-height') || '640';
    var theme = el.getAttribute('data-theme') || '';
    var url = ORIGIN + '/aquintutor/labs/' + encodeURIComponent(slug) + '?embed=1' + (theme ? '&theme=' + encodeURIComponent(theme) : '');
    var frame = document.createElement('iframe');
    frame.src = url;
    frame.title = 'EduRankAI Lab: ' + slug;
    frame.loading = 'lazy';
    frame.setAttribute('allow', 'accelerometer; gyroscope; microphone; fullscreen; clipboard-write');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals');
    frame.style.cssText = 'width:100%;border:0;border-radius:12px;display:block;height:' + (/^\d+$/.test(height) ? height + 'px' : height) + ';background:#0b0d13;';
    el.innerHTML = '';
    el.appendChild(frame);
    el.setAttribute('data-era-mounted', '1');
    el._eraFrame = frame;
  }

  function mountAll(root) {
    (root || document).querySelectorAll('[data-era-lab]').forEach(mount);
  }

  // Height auto-resize + event relay from the lab to the host page.
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.source !== 'era-lab') return;
    if (d.type === 'resize' && typeof d.height === 'number') {
      document.querySelectorAll('[data-era-lab][data-era-mounted]').forEach(function (el) {
        if (el._eraFrame && el._eraFrame.contentWindow === e.source && !el.getAttribute('data-height')) {
          el._eraFrame.style.height = d.height + 'px';
        }
      });
    }
    // Re-dispatch as a DOM CustomEvent so hosts can listen: document.addEventListener('era-lab', fn)
    try { document.dispatchEvent(new CustomEvent('era-lab', { detail: d })); } catch (_) {}
  });

  // Public API
  window.EraLabs = {
    mount: mount,
    mountAll: mountAll,
    embedUrl: function (slug, opts) { opts = opts || {}; return ORIGIN + '/aquintutor/labs/' + slug + '?embed=1' + (opts.theme ? '&theme=' + opts.theme : ''); },
    catalog: function () { return fetch(ORIGIN + '/api/labs/catalog.json').then(function (r) { return r.json(); }); },
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mountAll(); });
  else mountAll();
})();
