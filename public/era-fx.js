/* EduRankAI live currency display.
 *
 * Shows any CHF-denominated price in the learner's own currency at LIVE ECB
 * rates, and renders a currency switcher. Settlement still happens server-side
 * in INR via Razorpay at the live rate — this is the display layer.
 *
 * Mark a price element:  <span class="era-price" data-chf="10">CHF 10</span>
 * Add a switcher mount:  <span id="era-currency"></span>
 *
 *   <script src="/era-fx.js" defer></script>
 */
(function () {
  var SYMBOLS = { INR: '₹', USD: '$', EUR: '€', GBP: '£', SGD: 'S$', AED: 'AED ', JPY: '¥', CHF: 'CHF ', AUD: 'A$', CAD: 'C$' };
  var LIST = ['INR', 'USD', 'EUR', 'GBP', 'CHF', 'SGD', 'AED', 'AUD', 'CAD', 'JPY'];
  var rates = null, live = false;

  function preferred() {
    try { var s = localStorage.getItem('era_currency'); if (s) return s; } catch (e) {}
    // infer from locale
    var loc = (navigator.language || 'en-IN');
    if (/-IN$/i.test(loc)) return 'INR';
    if (/-US$/i.test(loc)) return 'USD';
    if (/-GB$/i.test(loc)) return 'GBP';
    if (/-(DE|FR|ES|IT|NL|IE|AT|PT|FI)$/i.test(loc)) return 'EUR';
    if (/-CH$/i.test(loc)) return 'CHF';
    return 'INR';
  }
  function setPreferred(c) { try { localStorage.setItem('era_currency', c); } catch (e) {} }

  function fmt(amountChf, cur) {
    if (!rates || !rates[cur]) return null;
    var v = amountChf * rates[cur];
    var sym = SYMBOLS[cur] || (cur + ' ');
    // sensible rounding: whole units for INR/JPY, 2dp otherwise
    var s = (cur === 'INR' || cur === 'JPY') ? Math.round(v).toLocaleString('en-IN') : v.toFixed(2);
    return sym + s;
  }

  function render() {
    var cur = preferred();
    document.querySelectorAll('.era-price').forEach(function (el) {
      var chf = parseFloat(el.getAttribute('data-chf'));
      if (isNaN(chf)) return;
      var txt = fmt(chf, cur);
      if (txt) {
        el.textContent = txt;
        el.title = 'CHF ' + chf.toFixed(2) + ' · ' + (live ? 'live ECB rate' : 'indicative rate') + (cur !== 'INR' ? ' · charged in INR' : '');
      }
    });
  }

  function mountSwitcher() {
    var mount = document.getElementById('era-currency');
    if (!mount) return;
    var cur = preferred();
    var sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Currency');
    sel.style.cssText = 'background:transparent;border:1px solid rgba(14,11,8,0.2);color:inherit;padding:5px 10px;border-radius:6px;font-family:inherit;font-size:12px;cursor:pointer;';
    LIST.forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = c; if (c === cur) o.selected = true; sel.appendChild(o); });
    sel.addEventListener('change', function () { setPreferred(sel.value); render(); });
    mount.innerHTML = ''; mount.appendChild(sel);
  }

  function boot() {
    fetch('/api/fx/rates?base=CHF', { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d && d.ok) { rates = d.rates; live = !!d.live; render(); } })
      .catch(function () {});
    mountSwitcher();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  window.EraFX = { render: render, set: function (c) { setPreferred(c); render(); } };
})();
