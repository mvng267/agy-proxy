import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';

import { humanType } from '../../src/browser/human.js';

/**
 * `humanType` phải bảo đảm chữ THẬT SỰ nằm trong ô trước khi trả về.
 *
 * Vì sao cần: `page.keyboard.type` gõ vào phần tử đang có focus chứ không vào locator được
 * truyền. Nếu trang cướp focus giữa chừng — Google làm đúng thế trên màn "Welcome" — thì
 * mọi ký tự rơi ra ngoài, hàm vẫn trả về êm, rồi `clickNext` submit ô rỗng và Google báo
 * "Enter a password". Ảnh chụp agyproxy56 đúng cảnh đó; mỗi lần vậy tốn một lượt login.
 *
 * Test dựng lại bằng trang data: có script tự blur ô ngay khi nhận ký tự đầu.
 */

let browser: Browser;
let page: Page;

before(async () => {
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  page = await browser.newPage();
});
after(async () => {
  await browser?.close();
});

const trang = (script = '') =>
  `data:text/html,${encodeURIComponent(
    `<input id="o" type="password" style="width:300px">
     <div id="khac" contenteditable style="height:40px"></div>
     <script>${script}</script>`,
  )}`;

describe('humanType', () => {
  test('gõ bình thường thì ô có đủ chữ', async () => {
    await page.goto(trang());
    await humanType(page, page.locator('#o'), 'matkhau123');
    assert.equal(await page.locator('#o').inputValue(), 'matkhau123');
  });

  /**
   * Mốc quyết định: trang cướp focus sau ký tự đầu — không có bước kiểm thì ô chỉ có 1 ký
   * tự (hoặc rỗng) mà hàm vẫn trả về bình thường.
   */
  test('trang cướp focus giữa chừng — vẫn phải đủ chữ', async () => {
    await page.goto(
      trang(`
        let n = 0;
        document.getElementById('o').addEventListener('input', () => {
          if (n++ === 0) document.getElementById('khac').focus();
        });
      `),
    );
    await humanType(page, page.locator('#o'), 'matkhau123');
    assert.equal(
      await page.locator('#o').inputValue(),
      'matkhau123',
      'phải phát hiện chữ không vào ô rồi điền lại',
    );
  });

  test('ô readonly không điền được thì báo lỗi rõ, không im lặng', async () => {
    await page.goto(trang(`document.getElementById('o').readOnly = true;`));
    await assert.rejects(
      () => humanType(page, page.locator('#o'), 'matkhau123'),
      /Gõ vào ô không ăn/,
      'thà fail có lý do còn hơn submit ô rỗng',
    );
  });
});
