/* ================================================================================================
   public/mail/domains.js — add a domain, run the DNS check, store the verdict.

   THE CHECK IS TWO CALLS, DELIBERATELY.
     1. GET  /api/mail/dns-check?domain=…      the existing resolver. It is the route that
                                               distinguishes "no such record" from "the lookup did
                                               not run", which is the distinction that stops this
                                               screen talking somebody into breaking their SPF.
     2. POST /api/mail/product/settings        stores the verdict with a timestamp.

   Two calls instead of one, and no second copy of a resolver anywhere in this product.
   ============================================================================================== */
(function () {
  'use strict';
  var EM = window.EM;
  var root = document.getElementById('dRoot');
  if (!EM || !root) return;

  function checkOne(domain, id, btn) {
    if (btn) EM.busy(btn, true, 'Checking');
    return EM.api('/api/mail/dns-check?domain=' + encodeURIComponent(domain)).then(function (res) {
      if (!res.ok) {
        if (btn) EM.busy(btn, false);
        EM.toast(res.error || ('The DNS check could not run for ' + domain + '. Nothing about your DNS has been concluded.'), 'bad', 10000);
        return null;
      }
      return EM.api('/api/mail/product/settings', { body: { action: 'domain-record', id: id, result: res } })
        .then(function (stored) {
          if (btn) EM.busy(btn, false);
          if (!stored.ok) { EM.toast(stored.error || 'The result could not be stored.', 'bad'); return res; }

          // The honest summary. "Some lookups did not complete" is said FIRST, because a partial
          // check read as a full one is the failure mode this whole screen is built around.
          var unchecked = (res.unchecked || []).length;
          if (unchecked) {
            EM.toast(domain + ': ' + unchecked + ' lookup' + (unchecked === 1 ? '' : 's') +
              ' did not complete, so those rows keep their last known answer. They are not a verdict on your DNS.', 'bad', 12000);
          } else if (res.spf && res.spf.multiple) {
            EM.toast(domain + ': more than one SPF record. Receivers treat that as a permanent error and the domain fails SPF entirely.', 'bad', 14000);
          } else {
            var pass = [res.spf && res.spf.present, res.dkim && res.dkim.present, res.dmarc && res.dmarc.present]
              .filter(Boolean).length;
            EM.toast(domain + ': ' + pass + ' of 3 authentication records found.', pass === 3 ? 'ok' : '', 6000);
          }
          return res;
        });
    });
  }

  root.addEventListener('click', function (e) {
    var check = e.target.closest('[data-d-check]');
    if (check) {
      checkOne(check.dataset.dCheck, check.dataset.id, check).then(function (res) {
        if (res) setTimeout(function () { location.reload(); }, 1600);
      });
      return;
    }

    var del = e.target.closest('[data-d-del]');
    if (del) {
      EM.confirm({
        title: 'Remove ' + del.dataset.name + '?',
        body: 'It stops being checked here. Nothing in your DNS is changed, and mail already sent from this domain is unaffected.',
        confirmLabel: 'Remove domain',
        tone: 'danger',
      }).then(function (yes) {
        if (!yes) return;
        EM.api('/api/mail/product/settings', { body: { action: 'domain-remove', id: del.dataset.dDel } })
          .then(function (res) {
            if (!res.ok) { EM.toast(res.error || 'Nothing was removed.', 'bad'); return; }
            location.reload();
          });
      });
    }
  });

  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-d-add]')) {
      var domain = window.prompt('Domain name, without a scheme or path\n\nFor example: edurankai.in', '');
      if (!domain || !domain.trim()) return;
      EM.api('/api/mail/product/settings', { body: { action: 'domain-add', domain: domain.trim() } })
        .then(function (res) {
          if (!res.ok) { EM.toast(res.error || 'The domain was not added.', 'bad', 8000); return; }
          EM.toast('Domain added. Checking its records…', 'ok');
          checkOne(domain.trim().toLowerCase(), res.id, null).then(function () {
            setTimeout(function () { location.reload(); }, 1400);
          });
        });
      return;
    }

    var all = e.target.closest('[data-d-checkall]');
    if (all) {
      var cards = Array.prototype.slice.call(root.querySelectorAll('[data-d-check]'));
      if (!cards.length) { EM.toast('There are no domains to check.', 'bad'); return; }
      EM.busy(all, true, 'Checking ' + cards.length);
      // Sequential: each domain is eight-plus DNS-over-HTTPS lookups, and firing them all at once
      // is how a resolver starts refusing and every answer comes back "not checked".
      (function next(i) {
        if (i >= cards.length) {
          EM.busy(all, false);
          setTimeout(function () { location.reload(); }, 1200);
          return;
        }
        checkOne(cards[i].dataset.dCheck, cards[i].dataset.id, null).then(function () { next(i + 1); });
      })(0);
    }
  });
})();
