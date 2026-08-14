import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cmpVersion, isGitCheckout, checkUpdate, coBanMoi } from '../src/updater.js';

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

  test('repo này là git checkout nên tự cập nhật được', () => {
    assert.equal(isGitCheckout(), true);
  });
});

describe('phát hiện bản mới theo COMMIT, không theo version', () => {
  /**
   * ĐÂY LÀ BUG ĐÃ GẶP THẬT (12/08/2026).
   *
   * `hasUpdate` cũ = `cmpVersion(latest, current) > 0`. Nhưng 8 commit gần nhất — kể cả
   * bản vá vòng quota tắc 28 giờ — đều không tăng version, nên local và remote cùng
   * `2.18.1`:
   *
   *   hasUpdate = cmpVersion("2.18.1", "2.18.1") > 0 = false
   *
   * Dashboard ẩn nút Cập nhật và endpoint POST trả `{upToDate: true}` — có 8 commit mới
   * vẫn báo "đã là bản mới nhất". Phải SSH vào server `git pull` bằng tay.
   *
   * Version là thứ người ta QUÊN bump; commit SHA thì không thể quên.
   */
  test('cùng version nhưng KHÁC commit → vẫn phải báo có bản mới', () => {
    assert.equal(coBanMoi({ localSha: 'aaa111', remoteSha: 'bbb222' }), true);
  });

  test('cùng commit → không có bản mới, dù version chênh', () => {
    // Version lệch mà commit trùng nghĩa là ai đó sửa package.json trên GitHub — cây mã
    // vẫn y hệt, không có gì để kéo về.
    assert.equal(coBanMoi({ localSha: 'aaa111', remoteSha: 'aaa111' }), false);
  });

  test('thiếu SHA (mất mạng / không phải git) → KHÔNG đoán bừa là có bản mới', () => {
    // Báo nhầm "có bản mới" khiến người dùng bấm vào một tiến trình chắc chắn thất bại.
    assert.equal(coBanMoi({ localSha: 'aaa111', remoteSha: null }), false);
    assert.equal(coBanMoi({ localSha: null, remoteSha: 'bbb222' }), false);
    assert.equal(coBanMoi({ localSha: null, remoteSha: null }), false);
  });

  test('SHA ngắn khớp SHA dài — GitHub trả 40 ký tự, git log hay đưa 7', () => {
    /**
     * `git rev-parse --short HEAD` cho 7 ký tự còn API GitHub trả đủ 40. So thẳng chuỗi
     * là LUÔN khác nhau → báo có bản mới vĩnh viễn, bấm cập nhật xong vẫn báo tiếp.
     */
    assert.equal(coBanMoi({ localSha: '7195ec3', remoteSha: '7195ec3d4f8a9b2c1e5f6a7b8c9d0e1f2a3b4c5d' }), false);
    assert.equal(coBanMoi({ localSha: '7195ec3d4f8a9b2c1e5f6a7b8c9d0e1f2a3b4c5d', remoteSha: '7195ec3' }), false);
  });

  test('SHA khác nhau ở tiền tố → là bản mới thật', () => {
    assert.equal(coBanMoi({ localSha: '7195ec3', remoteSha: '8bf793c1a2b3' }), true);
  });

  test('local ĐI TRƯỚC remote (behind=0) → KHÔNG phải bản mới', () => {
    /**
     * BẮT ĐƯỢC KHI CHẠY THẬT, không phải khi đọc code.
     *
     * Trên máy dev vừa commit chưa push: SHA local `8bf793c` khác SHA remote `7195ec3`
     * nên bản đầu của chính hàm này trả `true` — nhưng `git rev-list HEAD..origin/main`
     * đếm ra **0**, tức không có gì để kéo. Bấm Cập nhật thì `git pull --ff-only` chạy
     * không, còn thẻ vẫn báo "có bản mới" mãi mãi.
     *
     * Đo được `behind` thì nó là câu trả lời, không phải phép so SHA.
     */
    assert.equal(coBanMoi({ localSha: '8bf793c', remoteSha: '7195ec3', behind: 0 }), false);
  });

  test('behind > 0 → đúng là thiếu commit', () => {
    assert.equal(coBanMoi({ localSha: '7195ec3', remoteSha: '8bf793c', behind: 8 }), true);
  });

  test('không đo được behind → đành dựa vào SHA khác nhau', () => {
    // Không phải git checkout, hoặc `git fetch` hỏng. Thà báo có bản mới còn hơn giấu.
    assert.equal(coBanMoi({ localSha: '7195ec3', remoteSha: '8bf793c', behind: null }), true);
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

describe('runUpdate — lùi được khi hỏng giữa chừng', () => {
  const SRC = readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf8');

  test('ghi lại SHA TRƯỚC khi pull', () => {
    /**
     * `git pull` xong mà `npm install` chết là cây làm việc ở code MỚI với dependency CŨ
     * — trạng thái lai không chạy nổi. Không ghi mốc trước thì không biết lùi về đâu.
     */
    // Tìm LỆNH thật (`run('git pull'…`), không phải chuỗi "git pull" trong comment giải
    // thích — chính comment của bước này cũng nhắc tới nó.
    const i = SRC.indexOf("run('git pull'");
    assert.ok(i > 0, 'không tìm thấy lệnh git pull');
    assert.match(SRC.slice(0, i), /const mocCu = await localCommit\(\)/, 'phải lấy SHA trước khi pull');
  });

  test('npm install lỗi → lùi lại', () => {
    assert.match(SRC, /await lui\('npm install thất bại'\)/);
    assert.match(SRC, /reset', '--hard', mocCu/, 'phải reset về mốc cũ');
  });

  test('lùi hỏng thì nói rõ lệnh chạy tay, không im lặng', () => {
    // Người vận hành đang hoảng thì đừng bắt họ tự mò SHA cũ ở đâu ra.
    assert.match(SRC, /KHÔNG lùi được, chạy tay: git reset --hard/);
  });

  test('build web lỗi thì KHÔNG lùi — quyết định có chủ đích', () => {
    /**
     * Khác nhánh `npm install`: backend đã lên code mới và CHẠY ĐƯỢC, chỉ giao diện là cũ.
     * Lùi lại là vứt bản vá backend để đổi lấy dashboard mới — đánh đổi sai, nhất là khi
     * bản vá đó đang sửa sự cố production.
     */
    const i = SRC.indexOf('if (!webOk)');
    const doan = SRC.slice(i, i + 400);
    assert.doesNotMatch(doan, /await lui\(/, 'build web lỗi KHÔNG được lùi');
    assert.match(SRC, /CỐ Ý KHÔNG lùi/, 'phải ghi rõ vì sao không lùi');
  });
});

describe('CLI và dashboard dùng CHUNG một đường, không phải hai bản chép', () => {
  const CLI = readFileSync(new URL('../bin/agyproxy.mjs', import.meta.url), 'utf8');
  const SRV = readFileSync(new URL('../src/updater.ts', import.meta.url), 'utf8');

  test('CLI gọi runUpdate() của src/updater.ts', () => {
    /**
     * Trước đây CLI có bản CHÉP gần y hệt (~65 dòng), và chúng ĐÃ lệch nhau thật:
     * dashboard dọn `web/dist` trước khi pull còn CLI thì chưa, nên `agyproxy update`
     * trên production chết với "local changes to web/dist/index.html would be
     * overwritten". Vá xong bên này thì bên kia lại thiếu thứ khác.
     */
    assert.match(CLI, /runUpdate/, 'CLI phải dùng runUpdate chung');
    assert.match(CLI, /src\/updater\.ts/, 'CLI phải nạp thẳng module dùng chung');
  });

  test('CLI KHÔNG còn tự chạy git pull / npm install', () => {
    // Dấu hiệu bản chép quay lại. Mọi lệnh cài đặt phải nằm trong `src/updater.ts`.
    assert.doesNotMatch(CLI, /'pull', '--ff-only'/, 'CLI còn tự pull — bản chép quay lại');
    assert.doesNotMatch(CLI, /'install', '--omit=dev'/, 'CLI còn tự npm install');
    assert.doesNotMatch(CLI, /'run', 'build'/, 'CLI còn tự build web');
  });

  test('CLI vẫn giữ hai việc dashboard không làm được', () => {
    // Dừng tiến trình trước khi ghi đè file đang chạy, và khởi động lại sau khi xong.
    const i = CLI.indexOf('async function update(');
    const than = CLI.slice(i, i + 2200);
    assert.match(than, /stop\(\)/, 'CLI phải dừng tiến trình trước khi cập nhật');
    assert.match(than, /start\(true\)/, 'CLI phải khởi động lại sau khi cập nhật');
  });

  test('install dùng development, build dùng production — KHÔNG trộn', () => {
    /**
     * Hai bước cần hai giá trị NGƯỢC NHAU, trộn làm một là hỏng một trong hai:
     *  · install với production → npm bỏ devDeps → vite biến mất → `tsc -b` chết
     *  · build với development → Vite BỎ MINIFY → chunk 477 KB thay vì 281 KB
     * Cả hai lỗi đều đã xảy ra thật trên production.
     *
     * Nay chỉ còn MỘT nơi cần kiểm — đó chính là lợi ích của việc gộp.
     */
    assert.match(SRV, /NODE_ENV: 'development'/, 'thiếu development cho install');
    const buildPart = SRV.slice(SRV.indexOf("'build web'"));
    assert.match(buildPart.slice(0, 300), /NODE_ENV: 'production'/, 'bước build phải dùng production');
  });
});
