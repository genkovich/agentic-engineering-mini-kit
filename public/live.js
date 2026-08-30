// The only client-side script in the project. Loaded as a file, not inline, because the page
// declares script-src 'self'.
const feed = document.getElementById('feed');
if (feed) {
  let first = true;
  const source = new EventSource('/api/events');

  source.addEventListener('append', (message) => {
    const payload = JSON.parse(message.data);
    if (first) { feed.textContent = ''; first = false; }
    for (const event of payload.events) {
      const row = document.createElement('div');
      const when = event.at ? event.at.slice(11, 19) : new Date().toISOString().slice(11, 19);
      row.textContent = `${when}  ${payload.project}  ${event.kind}  ${event.label}`;
      if (event.kind === 'error') row.style.color = 'var(--bad)';
      feed.prepend(row);
      while (feed.children.length > 200) feed.lastChild.remove();
    }
  });

  source.onerror = () => {
    const row = document.createElement('div');
    row.textContent = 'stream dropped, the browser will retry';
    row.style.color = 'var(--warm)';
    feed.prepend(row);
  };
}
