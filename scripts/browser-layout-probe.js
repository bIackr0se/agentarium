// Evaluate in the rendered page after opening the surface being checked.
// This read-only probe complements screenshots; it does not grade visual composition.
(() => {
  const root = document.querySelector('dialog[open]') || document;
  const width = document.documentElement.clientWidth;
  const failures = [];
  if (document.documentElement.scrollWidth > width+1) failures.push({kind:'page-overflow'});
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(e).visibility === 'hidden') return false;
    for (let p = e.parentElement; p; p = p.parentElement) {
      if (p.tagName === 'DETAILS' && !p.open && !p.querySelector('summary')?.contains(e)) return false;
    }
    return true;
  };
  const rect = (e) => e.getBoundingClientRect();
  const apart = (a,b) => {
    const x=rect(a), y=rect(b);
    return x.right+2 <= y.left || y.right+2 <= x.left || x.bottom+2 <= y.top || y.bottom+2 <= x.top;
  };
  for (const e of root.querySelectorAll('button,input,select,summary,h1,h2,h3,p,pre,.timeline-event__context,.mission-phase-trail,.utility-dock__panel,.toolbar__source-setup,.world-rail,.agent-focus-card,.evidence-proof-card')) {
    if (!visible(e) || e.matches('.agent-villager')) continue;
    const r=rect(e);
    if (r.left < -1 || r.right > width+1) failures.push({kind:'outside-viewport',selector:e.className,text:e.textContent.slice(0,80)});
    if (e.clientWidth && e.scrollWidth > e.clientWidth+2 && getComputedStyle(e).textOverflow !== 'ellipsis') failures.push({kind:'content-overflow',selector:e.className,text:e.textContent.slice(0,80)});
  }
  for (const row of root.querySelectorAll('.timeline-event__when')) {
    const time=row.querySelector('time'), duration=row.querySelector('span');
    if (duration && !apart(time,duration)) failures.push({kind:'time-duration-spacing'});
  }
  for (const panel of root.querySelectorAll('.utility-dock__panel,.toolbar__source-setup,dialog[open]')) {
    if(visible(panel) && rect(panel).bottom > document.documentElement.clientHeight+1) failures.push({kind:'panel-below-viewport',selector:panel.className});
  }
  const panel=root.querySelector('.utility-dock__panel');
  if (panel && visible(panel)) {
    const close=panel.querySelector('.utility-dock__close'), header=panel.querySelector('h2');
    if (!apart(close,header)) failures.push({kind:'close-heading-overlap'});
    const edges=panel.querySelectorAll('.replay-control__edge');
    if (edges.length===2 && Math.abs(rect(edges[0]).left-rect(edges[1]).left) < 2) failures.push({kind:'range-label-alignment'});
  }
  const count=root.querySelector('.mission-board__count');
  if(count && !apart(count.querySelector('strong'),count.querySelector('span'))) failures.push({kind:'mission-count-spacing'});
  const date=root.querySelector('.mission-summary__date'), range=root.querySelector('.mission-summary__range');
  if(date && range && !apart(date,range)) failures.push({kind:'summary-date-spacing'});
  const action = root.querySelector('.overview-summary__action:hover .overview-summary__action-meta > strong');
  if (action && visible(action)) {
    const luminance = (color) => {
      const rgb = color.match(/[\d.]+/g).slice(0,3).map(Number).map(n => n/255);
      const linear = rgb.map(n => n <= .04045 ? n/12.92 : ((n+.055)/1.055)**2.4);
      return linear[0]*.2126 + linear[1]*.7152 + linear[2]*.0722;
    };
    const background = luminance(getComputedStyle(action).backgroundColor);
    for (const part of [action, action.querySelector('svg')].filter(Boolean)) {
      const foreground = luminance(getComputedStyle(part).color);
      const ratio = (Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05);
      if (ratio < 4.5) failures.push({kind:'action-hover-contrast',ratio});
    }
  }
  return {width,documentWidth:document.documentElement.scrollWidth,failures};
})()
