import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Chọn model — MỘT bản dùng chung.
 *
 * Trước đây 4 trang tự viết và chúng ĐÃ PHÂN KỲ thật:
 *   Chat.tsx           `<select>` HTML tự viết, gom nhóm theo provider
 *   ApiPlayground.tsx  ui/select, đẩy combo lên đầu kèm số bước
 *   ModelCompare.tsx   ui/select dùng như nút "+ Thêm model"
 *   Combo.tsx          ui/select, lọc bỏ `combo/*` (không cho combo lồng combo)
 *
 * Mỗi bản biết một luật mà bản khác không biết — người dùng ở trang này thấy nhóm
 * provider, sang trang kia thì không. Trang thứ 5 sẽ lại chép từ bản gần nhất và thiếu
 * tiếp.
 */

const ROOT = resolve(import.meta.dirname, '../..');

/** Bỏ comment trước khi soi — chính lời giải thích cũng nhắc tên thứ đã gỡ. */
function code(f: string): string {
  return readFileSync(resolve(ROOT, f), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const MS = 'web/src/components/common/ModelSelect.tsx';
const TRANG = [
  'web/src/components/pages/Chat.tsx',
  'web/src/components/pages/ApiPlayground.tsx',
  'web/src/components/pages/ModelCompare.tsx',
  'web/src/components/pages/Combo.tsx',
];

describe('ModelSelect tồn tại và giữ đủ luật của 4 trang', () => {
  test('file có mặt', () => {
    assert.ok(existsSync(resolve(ROOT, MS)));
  });

  test('giữ luật gom nhóm provider (từ Chat)', () => {
    const s = code(MS);
    assert.match(s, /providerLabel/, 'phải nhóm theo nhãn provider');
    assert.match(s, /gomNhom/);
  });

  test('giữ luật đẩy combo lên đầu + số bước (từ ApiPlayground)', () => {
    const s = code(MS);
    assert.match(s, /comboFirst/);
    assert.match(s, /steps\?\.length/, 'phải hiện số bước của combo');
  });

  test('giữ luật loại combo (từ Combo — không cho combo lồng combo)', () => {
    /**
     * Thiếu luật này thì người dùng chọn được `combo/x` làm bước của `combo/x` — vòng lặp
     * vô hạn ở phía engine.
     */
    const s = code(MS);
    assert.match(s, /excludeCombo/);
    assert.match(s, /startsWith\("combo\/"\)/);
  });

  test('giữ luật ẩn model đã chọn (từ ModelCompare/Combo)', () => {
    assert.match(code(MS), /exclude\?:/);
  });

  test('gom nhóm CHỈ khi có nhiều provider', () => {
    // Một nhóm mà vẫn hiện tiêu đề nhóm thì chỉ tổ rối.
    assert.match(code(MS), /Object\.keys\(nhom\)\.length > 1/);
  });
});

describe('4 trang đều dùng bản chung, không còn tự viết', () => {
  for (const f of TRANG) {
    test(`${f.split('/').pop()} import ModelSelect`, () => {
      assert.match(code(f), /from "@\/components\/common\/ModelSelect"/);
    });
  }

  test('không trang nào còn tự dựng dropdown model', () => {
    /**
     * Dấu hiệu tự viết: map thẳng danh sách model thành SelectItem/option. Nếu tái diễn,
     * luật mới thêm vào ModelSelect sẽ không tới được trang đó.
     */
    for (const f of TRANG) {
      const s = code(f);
      assert.doesNotMatch(s, /models\.map\(\(m\) => \(\s*<option/, `${f}: còn tự dựng <option>`);
      assert.doesNotMatch(s, /availableModels\.map/, `${f}: còn tự lọc danh sách model`);
    }
  });

  test('Chat không còn optgroup tự viết', () => {
    assert.doesNotMatch(code('web/src/components/pages/Chat.tsx'), /<optgroup/);
  });
});

describe('không gọi API model hai lần trên cùng trang', () => {
  test('dùng chung queryKey ["models"] để React Query gộp cache', () => {
    /**
     * `ApiPlayground` cần danh sách model để đặt giá trị mặc định, `ModelSelect` cần để
     * dựng dropdown. Cùng queryKey thì React Query chỉ gọi API một lần.
     */
    assert.match(code(MS), /queryKey: \["models"\]/);
    assert.match(code('web/src/components/pages/ApiPlayground.tsx'), /useModels\(\)/);
  });

  test('Combo KHÔNG còn fetch model riêng', () => {
    // Trước đây nó fetch trần trong `fetchData`, tách rời khỏi cache của React Query.
    const s = code('web/src/components/pages/Combo.tsx');
    assert.doesNotMatch(s, /fetch\("\/api\/gateway\/models"\)/);
  });
});

describe('kiểu Model dùng chung mang đủ trường', () => {
  test('có providerLabel, kind, steps', () => {
    /**
     * `ApiPlayground` từng khai `interface Model` RIÊNG trong file vì kiểu chung thiếu
     * trường — đó là cách bản sao thứ hai ra đời.
     */
    const s = code('web/src/lib/types.ts');
    for (const t of ['providerLabel', 'kind', 'steps']) {
      assert.match(s, new RegExp(`${t}\\??:`), `types.ts thiếu ${t}`);
    }
  });

  test('ApiPlayground không còn khai interface Model riêng', () => {
    assert.doesNotMatch(code('web/src/components/pages/ApiPlayground.tsx'), /interface Model \{/);
  });
});
