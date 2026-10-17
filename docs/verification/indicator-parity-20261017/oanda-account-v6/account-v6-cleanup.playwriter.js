await state.accountChart.evaluate(()=>{for(const [owner,key,orig] of accountProbe.originals)owner[key]=orig;removeEventListener('message',accountProbe.listener);});
await state.accountPage.close();
await state.accountOandaPage.bringToFront();
console.log({temporaryObserversRemoved:true,retained:'GBPJPY OANDA M5 with Supertrend; saved real XAU composite page'});
