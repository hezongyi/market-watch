state.page = await context.newPage();
await state.page.addInitScript(() => {
  const proof = window.__particleProof = { frames: 0, circles: [], times: [], visibility: [] };
  const clear = CanvasRenderingContext2D.prototype.clearRect;
  const arc = CanvasRenderingContext2D.prototype.arc;
  CanvasRenderingContext2D.prototype.clearRect = function(...args) {
    if(this.canvas.closest('.login-particles')) {
      proof.frames++; proof.circles = []; proof.times.push(performance.now());
      if(proof.times.length > 150) proof.times.shift();
    }
    return clear.apply(this,args);
  };
  CanvasRenderingContext2D.prototype.arc = function(...args) {
    if(this.canvas.closest('.login-particles')) proof.circles.push(args.slice(0,3));
    return arc.apply(this,args);
  };
  document.addEventListener('visibilitychange', () => proof.visibility.push({state:document.visibilityState,frames:proof.frames}));
});
await state.page.setViewportSize({width:1440,height:900});
await state.page.goto('http://192.168.7.232:18320/login-particles.html?theme=dark');
console.log(await snapshot({page:state.page}));
console.log(await getLatestLogs({page:state.page,sinceLastCall:true}));
await state.page.screenshot({path:'/home/quant/repos/market-watch-login-particles-20261019/docs/verification/login-particles-preview-20261019/dark-desktop.png',scale:'css'});
console.log(await state.page.evaluate(() => ({frames:window.__particleProof.frames, count:window.__particleProof.circles.length, hidden:document.hidden, canvas:[document.querySelector('canvas').width,document.querySelector('canvas').height]})));
