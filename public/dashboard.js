// Hover and focus tooltips for the daily charts. Each column carries its payload in data-tip
// ({ title, subtitle, rows: [{ cls, name, text }] }, names and numbers only); this only renders
// it. No network, no storage.
(function () {
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function render(tip, data) {
    tip.replaceChildren();
    tip.append(el('div', 'tip-day', data.title));
    if (data.subtitle) tip.append(el('div', 'tip-total', data.subtitle));
    if (!data.rows || !data.rows.length) return;
    const list = el('ul');
    for (const row of data.rows) {
      const li = el('li');
      li.append(el('span', row.cls), el('span', '', row.name), el('span', 'num', row.text));
      list.append(li);
    }
    tip.append(list);
  }

  // Anchor to the top of the drawn bars, not the full-height hover zone; an empty day anchors
  // to the baseline.
  function anchorBox(col) {
    const bars = [...col.querySelectorAll('rect:not(.hit)')];
    if (!bars.length) {
      const hit = col.querySelector('.hit').getBoundingClientRect();
      return { left: hit.left, width: hit.width, top: hit.bottom };
    }
    const boxes = bars.map((b) => b.getBoundingClientRect());
    return { left: boxes[0].left, width: boxes[0].width, top: Math.min(...boxes.map((b) => b.top)) };
  }

  function place(host, tip, col) {
    const hostBox = host.getBoundingClientRect();
    const box = anchorBox(col);
    tip.hidden = false;
    const tipBox = tip.getBoundingClientRect();
    let left = box.left - hostBox.left + box.width / 2 - tipBox.width / 2;
    left = Math.max(0, Math.min(left, hostBox.width - tipBox.width));
    // Above the bars, even when that is above the chart itself: the panel heading is there.
    tip.style.left = `${left}px`;
    tip.style.top = `${box.top - hostBox.top - tipBox.height - 8}px`;
  }

  for (const host of document.querySelectorAll('.chart-host')) {
    const tip = host.querySelector('.chart-tip');
    if (!tip) continue;
    const show = (col) => {
      let data;
      try { data = JSON.parse(col.dataset.tip); } catch { return; }
      render(tip, data);
      place(host, tip, col);
    };
    const hide = () => { tip.hidden = true; };
    for (const col of host.querySelectorAll('.col')) {
      col.addEventListener('mouseenter', () => show(col));
      col.addEventListener('mouseleave', hide);
      col.addEventListener('focus', () => show(col));
      col.addEventListener('blur', hide);
    }
  }
})();
