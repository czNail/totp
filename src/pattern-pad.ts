import { appendPoint } from './pattern.ts';

/** Pointer capture keeps drags continuous on mouse, touch and pen; no global listeners. */
export class PatternPad {
  readonly element: HTMLDivElement;
  private path: number[] = [];
  private pointer: number | null = null;
  private last: { x: number; y: number } | null = null;
  private tip: { x: number; y: number } | null = null;
  private disabled = false;
  private events = new AbortController();
  private complete: (() => void) | null;

  constructor(container: HTMLElement, onComplete: () => void) {
    this.complete = onComplete;
    this.element = document.createElement('div');
    this.element.className = 'pattern-pad';
    this.element.tabIndex = 0;
    this.element.setAttribute('role', 'group');
    this.element.setAttribute('aria-label', '九宫格手势。按住绘制，或按数字 1 到 9 选点，回车确认。');
    this.element.innerHTML = `<svg viewBox="0 0 300 300" aria-hidden="true"><polyline points="" /><line /></svg><div class="pattern-nodes">${Array.from({ length: 9 }, (_, i) => `<button type="button" class="pattern-node" data-point="${i + 1}" aria-label="点 ${i + 1}" aria-pressed="false"><span></span></button>`).join('')}</div><span class="sr-only pattern-count" aria-live="polite"></span>`;
    container.replaceChildren(this.element);
    const options = { signal: this.events.signal };
    this.element.addEventListener('pointerdown', event => {
      if (this.disabled || this.pointer !== null || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      this.clear();
      this.pointer = event.pointerId;
      this.element.focus({ preventScroll: true });
      this.element.setPointerCapture(event.pointerId);
      this.sample(event);
    }, options);
    this.element.addEventListener('pointermove', event => {
      if (this.pointer !== event.pointerId || this.disabled) return;
      event.preventDefault();
      const samples = event.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length ? samples : [event]) this.sample(sample);
    }, options);
    this.element.addEventListener('pointerup', event => {
      if (this.pointer !== event.pointerId) return;
      this.sample(event);
      this.pointer = null; this.last = null; this.tip = null;
      this.paint();
      if (this.path.length) this.complete?.();
    }, options);
    const cancel = () => { if (this.pointer !== null) this.clear(); };
    this.element.addEventListener('pointercancel', cancel, options);
    this.element.addEventListener('lostpointercapture', cancel, options);
    this.element.addEventListener('click', event => {
      if (this.disabled || event.detail !== 0) return;
      const button = (event.target as Element).closest<HTMLElement>('[data-point]');
      if (button) { this.path = appendPoint(this.path, Number(button.dataset.point)); this.paint(); }
    }, options);
    this.element.addEventListener('keydown', event => {
      if (this.disabled) return;
      if (/^[1-9]$/.test(event.key)) {
        event.preventDefault(); this.path = appendPoint(this.path, Number(event.key)); this.paint();
      } else if (event.key === 'Enter') {
        if ((event.target as Element).closest('[data-point]')) return;
        event.preventDefault(); this.complete?.();
      } else if (event.key === 'Backspace' || (event.key === 'Escape' && this.path.length)) {
        event.preventDefault(); event.stopPropagation(); this.clear();
      }
    }, options);
    this.paint();
  }
  get value(): string { return this.path.join(''); }
  clear() { this.path = []; this.pointer = null; this.last = null; this.tip = null; this.paint(); }
  setDisabled(disabled: boolean) {
    this.disabled = disabled;
    this.element.setAttribute('aria-disabled', String(disabled));
    this.element.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = disabled; });
    this.element.classList.toggle('is-disabled', disabled);
  }
  destroy() { this.complete = null; this.events.abort(); this.clear(); }
  private sample(event: PointerEvent) {
    const box = this.element.getBoundingClientRect();
    const current = { x: (event.clientX - box.left) * 300 / box.width, y: (event.clientY - box.top) * 300 / box.height };
    const previous = this.last ?? current;
    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    const length = dx * dx + dy * dy;
    const hits: { point: number; t: number }[] = [];
    for (let point = 1; point <= 9; point++) {
      const center = this.center(point);
      const t = length ? Math.max(0, Math.min(1, ((center.x - previous.x) * dx + (center.y - previous.y) * dy) / length)) : 0;
      if (Math.hypot(center.x - previous.x - t * dx, center.y - previous.y - t * dy) <= 24) hits.push({ point, t });
    }
    for (const hit of hits.sort((a, b) => a.t - b.t)) this.path = appendPoint(this.path, hit.point);
    this.last = current; this.tip = current; this.paint();
  }
  private center(point: number) { return { x: 50 + ((point - 1) % 3) * 100, y: 50 + Math.floor((point - 1) / 3) * 100 }; }
  private paint() {
    this.element.querySelector('polyline')!.setAttribute('points', this.path.map(point => { const p = this.center(point); return `${p.x},${p.y}`; }).join(' '));
    const line = this.element.querySelector('line')!;
    const end = this.path.at(-1);
    line.style.display = end && this.tip ? '' : 'none';
    if (end && this.tip) {
      const start = this.center(end);
      for (const [key, value] of Object.entries({ x1: start.x, y1: start.y, x2: this.tip.x, y2: this.tip.y })) line.setAttribute(key, String(value));
    }
    this.element.querySelectorAll<HTMLButtonElement>('[data-point]').forEach(button => {
      const selected = this.path.includes(Number(button.dataset.point));
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    const count = this.element.querySelector('.pattern-count')!;
    const text = this.path.length ? `已连接 ${this.path.length} 个点` : '';
    if (count.textContent !== text) count.textContent = text;
  }
}
