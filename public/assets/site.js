/* Progressively enhance the footer status line. No framework, no CDN. */
(function () {
  var el = document.querySelector('[data-health]');
  if (!el) return;
  var started = performance.now();
  fetch('/health', { headers: { accept: 'application/json' } })
    .then(function (response) {
      if (!response.ok) throw new Error(String(response.status));
      return response.json();
    })
    .then(function (data) {
      var ms = Math.round(performance.now() - started);
      el.textContent = 'API operational · v' + data.version + ' · ' + ms + ' ms';
      el.setAttribute('data-state', 'ok');
    })
    .catch(function () {
      el.textContent = 'API status unavailable';
      el.setAttribute('data-state', 'err');
    });
})();
