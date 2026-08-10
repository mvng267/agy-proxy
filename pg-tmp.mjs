import { chromium } from 'playwright';
const S = process.env.S, BASE='http://127.0.0.1:7788';
const b = await chromium.launch();
const p = await (await b.newContext({viewport:{width:1600,height:1050},colorScheme:'dark',deviceScaleFactor:2})).newPage();
const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
await p.goto(`${BASE}/login`,{waitUntil:'networkidle'});
await p.getByRole('button',{name:'Dùng mật khẩu chữ'}).click();
await p.fill('#passText','123123'); await p.click('#btnText');
await p.waitForURL(u=>!/login/.test(u.toString()),{timeout:15000});

await p.goto(`${BASE}/playground?tab=compare`,{waitUntil:'networkidle'}); await p.waitForTimeout(2500);
const t0 = await p.evaluate(()=>document.querySelector('main')?.innerText||'');
console.log('model mo san:', (t0.match(/(\d)\/6/)||[])[1] ?? '?');

await (await p.$('main textarea')).fill('Thu do Viet Nam la gi? Tra loi 1 tu.');
const btn = await p.getByRole('button',{name:/Gửi \d model/});
console.log('nut:', (await btn.innerText()).trim());
await btn.click();
await p.waitForTimeout(2000);
console.log('nut Huy khi dang chay:', await p.getByRole('button',{name:'Huỷ'}).count());

await p.waitForTimeout(60000);
const t = await p.evaluate(()=>document.querySelector('main')?.innerText||'');
console.log('so the ket qua:', (t.match(/\ds\b/g)||[]).length);
console.log('co nhan "nhanh nhat"?:', /nhanh nhất/.test(t)?'co':'khong');
console.log('co "token"?:', /token/.test(t)?'co':'khong');
await p.screenshot({path:`${S}/pg-compare.png`});
console.log('pageerror:', errs.length, errs.slice(0,2).join(' | '));
await b.close();
