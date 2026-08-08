import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cmpVersion, isGitCheckout, checkUpdate } from '../src/updater.js';

describe('cmpVersion', () => {
  test('so sánh đúng theo từng thành phần, không so chuỗi', () => {
    // So chuỗi thì '2.9.0' > '2.10.0' — lỗi kinh điển khiến bản mới không được nhận ra.
    assert.ok(cmpVersion('2.10.0', '2.9.0') > 0);
    assert.ok(cmpVersion('2.15.1', '2.15.0') > 0);
    assert.equal(cmpVersion('2.15.0', '2.15.0'), 0);
    assert.ok(cmpVersion('2.15.0', '3.0.0') < 0);
  });

  test('thiếu thành phần coi như 0', () => {
    assert.equal(cmpVersion('2.15', '2.15.0'), 0);
    assert.ok(cmpVersion('2.15.1', '2.15') > 0);
  });
});

describe('checkUpdate', () => {
  test('luôn trả về phiên bản hiện tại, kể cả khi mất mạng', async () => {
    const r = await checkUpdate();
    assert.match(r.current, /^\d+\.\d+\.\d+$/, 'current phải là semver đọc từ package.json');
    // latest có thể null nếu GitHub không tới được — nhưng KHÔNG được ném, vì
    // dashboard gọi endpoint này mỗi lần mở trang Cấu hình.
    assert.ok(r.latest === null || /^\d+\.\d+\.\d+$/.test(r.latest));
    if (r.latest === null) assert.ok(r.error, 'không lấy được latest thì phải nói lý do');
    assert.equal(typeof r.canSelfUpdate, 'boolean');
  });

  test('hasUpdate chỉ true khi remote THỰC SỰ mới hơn', async () => {
    const r = await checkUpdate();
    if (r.latest) assert.equal(r.hasUpdate, cmpVersion(r.latest, r.current) > 0);
    else assert.equal(r.hasUpdate, false, 'không biết latest thì không được báo có bản mới');
  });

  test('repo này là git checkout nên tự cập nhật được', () => {
    assert.equal(isGitCheckout(), true);
  });
});

describe('runUpdate — build web trong môi trường production', () => {
  const SRC = readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf8');

  test('npm install (web) ép NODE_ENV=development để có devDeps', () => {
    // systemd đặt NODE_ENV=production, tiến trình server kế thừa, và npm TỰ BỎ
    // devDependencies khi thấy biến đó — vite/@types/node biến mất, `tsc -b` chết.
    // Bắt được trên máy production thật bằng cách bấm nút Cập nhật.
    const webPart = SRC.slice(SRC.indexOf('web/package.json'));
    assert.match(webPart.slice(0, 900), /npm install \(web\)[\s\S]{0,220}NODE_ENV: 'development'/);
  });

  test('build web lỗi thì KHÔNG báo "xong" thành công', () => {
    // Trước đây bước cuối luôn ok:true dù build hỏng → người dùng tưởng đã cập nhật
    // xong trong khi dashboard vẫn chạy dist cũ.
    assert.match(SRC, /if \(!webOk\)/, 'phải có nhánh xử lý build web thất bại');
    assert.match(SRC, /BUILD WEB LỖI/, 'phải nói rõ dashboard đang chạy giao diện cũ');
  });
});

describe('runUpdate — web/dist là sản phẩm build, không phải code', () => {
  const SRC = readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf8');

  test('dọn web/dist trước khi pull', () => {
    // web/dist ĐƯỢC commit (server serve dashboard từ đó) nên mỗi lần build sinh hash
    // file mới là thư mục bẩn ngay. Coi đó là "code sắp mất" thì nút Cập nhật chỉ chạy
    // được ĐÚNG MỘT LẦN rồi tắc vĩnh viễn — gặp thật trên production.
    assert.match(SRC, /checkout', '--', 'web\/dist'/, 'phải git checkout web/dist');
    assert.match(SRC, /clean', '-fd', 'web\/dist'/, 'phải xoá file dist mới sinh (untracked)');
  });

  test('vẫn dừng khi có thay đổi THẬT ngoài web/dist', () => {
    // Không được nới lỏng thành "kệ hết" — code người viết vẫn phải được bảo vệ.
    assert.match(SRC, /!f\.startsWith\('web\/dist\/'\)/, 'chỉ bỏ qua web/dist');
    assert.match(SRC, /dừng để không mất code/);
  });

  test('package-lock không bị coi là code chưa commit', () => {
    // npm install sửa lockfile là chuyện thường, chặn vì nó thì nút không bao giờ chạy.
    assert.match(SRC, /f !== 'package-lock\.json'/);
  });
});

describe('CLI và dashboard phải làm CÙNG một việc', () => {
  const CLI = readFileSync(new URL('../bin/agyproxy.mjs', import.meta.url), 'utf8');
  const SRV = readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf8');

  test('cả hai đều dọn web/dist trước khi pull', () => {
    // Gặp thật: dashboard đã dọn nhưng CLI thì chưa, nên `agyproxy update` trên
    // production chết với "local changes to web/dist/index.html would be overwritten".
    for (const [name, src] of [['CLI', CLI], ['dashboard', SRV]] as const) {
      assert.match(src, /checkout'.*'web\/dist'/, `${name} thiếu bước dọn web/dist`);
      assert.match(src, /clean'.*'web\/dist'/, `${name} thiếu git clean web/dist`);
    }
  });

  test('install dùng development, build dùng production — KHÔNG trộn', () => {
    // Hai bước cần hai giá trị NGƯỢC NHAU, trộn làm một là hỏng một trong hai:
    //  · install với production → npm bỏ devDeps → vite biến mất → `tsc -b` chết
    //  · build với development → Vite BỎ MINIFY → chunk 477 KB thay vì 281 KB
    // Cả hai lỗi đều đã xảy ra thật trên production.
    for (const [name, src] of [['CLI', CLI], ['dashboard', SRV]] as const) {
      assert.match(src, /NODE_ENV: 'development'/, `${name} thiếu development cho install`);
      assert.match(src, /NODE_ENV: 'production'/, `${name} thiếu production cho build`);
      // Bước build phải đi kèm production, không phải development
      const buildPart = src.slice(src.indexOf("'build web'") >= 0 ? src.indexOf("'build web'") : src.indexOf("'run', 'build'"));
      assert.match(buildPart.slice(0, 300), /NODE_ENV: 'production'/, `${name}: bước build phải dùng production`);
    }
  });
});
