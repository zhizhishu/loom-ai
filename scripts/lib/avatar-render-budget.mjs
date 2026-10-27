// Shared measurement for the production MemberAvatar in Electron and Chrome.
// Report frame scheduling; do not turn host-dependent timing into a flaky CI gate.
export async function measureAvatarBudget(evaluate, captureBase64) {
  const metrics = await evaluate(`(async () => {
    const gaps = [], longTasks = [];
    const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(entry => entry.duration)));
    observer.observe({ type: 'longtask', buffered: false });
    let previous = performance.now();
    const end = previous + 3000;
    await new Promise(resolve => {
      const frame = now => { gaps.push(now - previous); previous = now; if (now < end) requestAnimationFrame(frame); else resolve(); };
      requestAnimationFrame(frame);
    });
    observer.disconnect();
    gaps.sort((a, b) => a - b);
    return { avatars: document.querySelectorAll('[data-stress] img').length,
      frameP95Ms: gaps[Math.floor(gaps.length * .95)], maxFrameMs: gaps.at(-1),
      longTasks: longTasks.length, maxLongTaskMs: Math.max(0, ...longTasks) };
  })()`)
  const colors = Array.from({ length: metrics.avatars }, () => new Set())
  // Sample screenshots, since drawing an animated <img> onto a canvas can use
  // its default frame instead of the currently painted animation.
  for (let n = 0; n < 8; n++) {
    const png = await captureBase64()
    const pixels = await evaluate(`(async () => {
      const image = new Image(); image.src = 'data:image/png;base64,${png}'; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(image, 0, 0);
      return [...document.querySelectorAll('[data-stress] .member-avatar')].map(node => {
        const r = node.getBoundingClientRect();
        return [...ctx.getImageData(Math.floor((r.x+r.width/2)*image.width/innerWidth), Math.floor((r.y+r.height/2)*image.height/innerHeight), 1, 1).data].join(',');
      });
    })()`)
    pixels.forEach((value, index) => colors[index].add(value))
    await new Promise(resolve => setTimeout(resolve, 110))
  }
  return { ...metrics, animated: colors.filter(set => set.size > 1).length }
}
