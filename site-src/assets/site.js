// apü site: progressive enhancement only. Without this script the tab panels are stacked, code has
// no copy button and the table of contents doesn't follow the scroll — everything else works.
(() => {
  const d = document;

  // Tabs: [data-tabs] containing .tab-panel[data-tab] → an ARIA tablist (arrow keys, Home, End).
  d.querySelectorAll('[data-tabs]').forEach((box, n) => {
    const panels = [...box.querySelectorAll(':scope > .tab-panel')];
    if (panels.length < 2) return;
    const list = d.createElement('div');
    list.className = 'tablist';
    list.setAttribute('role', 'tablist');
    list.setAttribute('aria-label', box.dataset.tabs);
    const tabs = panels.map((panel, i) => {
      const tab = d.createElement('button');
      tab.type = 'button';
      tab.id = `tab-${n}-${i}`;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panel.id || (panel.id = `panel-${n}-${i}`));
      tab.innerHTML = `<span class="n" aria-hidden="true">${i + 1}</span>`;
      tab.append(panel.dataset.tab);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.tabIndex = -1;
      tab.addEventListener('click', () => select(i));
      list.append(tab);
      return tab;
    });
    const select = (i, focus) => {
      tabs.forEach((tab, j) => {
        const on = i === j;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
        panels[j].hidden = !on;
      });
      if (focus) tabs[i].focus();
    };
    list.addEventListener('keydown', (e) => {
      const i = tabs.indexOf(d.activeElement);
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (i < 0 || to === undefined) return;
      e.preventDefault();
      select((to + tabs.length) % tabs.length, true);
    });
    box.prepend(list);
    box.classList.add('enhanced');
    select(0);
  });

  // Copy buttons on code blocks. Console blocks copy the commands only (lines after "$ ").
  const icon = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5"/></svg>';
  if (navigator.clipboard) {
    d.querySelectorAll('figure.code').forEach((fig) => {
      const code = fig.querySelector('code');
      if (!code) return;
      const btn = d.createElement('button');
      btn.type = 'button';
      btn.className = 'copy-btn';
      btn.innerHTML = `${icon}<span>Copy</span>`;
      const label = btn.lastChild;
      btn.addEventListener('click', async () => {
        let text = code.textContent;
        if (code.classList.contains('language-console')) {
          const out = [];
          let more = false;
          for (const line of text.split('\n')) {
            if (line.startsWith('$ ') || more) {
              out.push(more ? line : line.slice(2));
              more = line.endsWith('\\');
            }
          }
          if (out.length) text = out.join('\n');
        }
        try {
          await navigator.clipboard.writeText(text.replace(/\n$/, ''));
          label.textContent = 'Copied';
        } catch {
          label.textContent = 'Failed';
        }
        setTimeout(() => (label.textContent = 'Copy'), 1600);
      });
      fig.append(btn);
    });
  }

  // Table of contents: mark the section being read.
  const links = [...d.querySelectorAll('.toc a[href^="#"]')];
  const heads = [...new Set(links.map((a) => d.getElementById(decodeURIComponent(a.hash.slice(1)))))].filter(Boolean);
  if (heads.length) {
    let current;
    let queued = false;
    const update = () => {
      queued = false;
      // the last heading above the upper third; at the very bottom, the last one
      const line = Math.min(innerHeight / 3, 200);
      let head = heads[0];
      for (const h of heads) if (h.getBoundingClientRect().top <= line) head = h;
      if (innerHeight + scrollY >= d.documentElement.scrollHeight - 2) head = heads[heads.length - 1];
      if (head === current) return;
      current = head;
      links.forEach((a) => (a.hash === `#${head.id}` ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current')));
    };
    addEventListener('scroll', () => queued || ((queued = true), requestAnimationFrame(update)), { passive: true });
    update();
  }
})();
