import type { Page, Locator } from 'playwright';

/**
 * Helper "hành vi người thật". Mọi thao tác chạm Google BẮT BUỘC đi qua đây,
 * cấm gọi fill()/click() trần. Xem RULES mục B trong plan.
 */

export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
export function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
/** Nghỉ ngẫu nhiên giữa các thao tác. */
export function think(minMs = 500, maxMs = 2500): Promise<void> {
  return sleep(rand(minMs, maxMs));
}

// Lưu vị trí chuột gần nhất theo từng page để di chuyển liên tục, không "teleport".
const mousePos = new WeakMap<Page, { x: number; y: number }>();

function getPos(page: Page): { x: number; y: number } {
  return mousePos.get(page) ?? { x: rand(60, 300), y: rand(60, 300) };
}

/** Di chuột theo quỹ đạo cong (bezier bậc 2) nhiều bước, có gia tốc. */
export async function humanMove(page: Page, tx: number, ty: number): Promise<void> {
  const from = getPos(page);
  const steps = randInt(12, 26);
  // điểm điều khiển lệch để tạo đường cong
  const cx = (from.x + tx) / 2 + rand(-80, 80);
  const cy = (from.y + ty) / 2 + rand(-80, 80);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // ease-in-out
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const x = (1 - e) * (1 - e) * from.x + 2 * (1 - e) * e * cx + e * e * tx;
    const y = (1 - e) * (1 - e) * from.y + 2 * (1 - e) * e * cy + e * e * ty;
    await page.mouse.move(x, y);
    await sleep(rand(6, 22));
  }
  await page.mouse.move(tx, ty);
  mousePos.set(page, { x: tx, y: ty });
}

/** Lấy tâm element, chờ tới khi có boundingBox (element vừa render/animation). */
async function boxCenter(loc: Locator): Promise<{ x: number; y: number }> {
  let box = await loc.boundingBox();
  for (let i = 0; i < 10 && !box; i++) {
    await sleep(250);
    box = await loc.boundingBox();
  }
  if (!box) throw new Error('Element không có bounding box (ẩn?)');
  return {
    x: box.x + box.width * rand(0.35, 0.65),
    y: box.y + box.height * rand(0.35, 0.65),
  };
}

/** Di chuột tới element, hover một chút rồi click bằng mouse.down/up. */
export async function humanClick(page: Page, loc: Locator): Promise<void> {
  await loc.waitFor({ state: 'visible', timeout: 30000 });
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await sleep(rand(120, 400));
  const { x, y } = await boxCenter(loc);
  await humanMove(page, x, y);
  await sleep(rand(200, 600)); // hover
  await page.mouse.down();
  await sleep(rand(40, 120));
  await page.mouse.up();
}

/** Gõ từng ký tự với delay ngẫu nhiên, thỉnh thoảng nghỉ dài (mô phỏng nghĩ). */
export async function humanType(page: Page, loc: Locator, text: string): Promise<void> {
  await humanClick(page, loc);
  await sleep(rand(150, 450));
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: rand(70, 180) });
    if (Math.random() < 0.06) await sleep(rand(250, 700)); // nghỉ nghĩ
  }
  await sleep(rand(200, 500));

  /**
   * Kiểm chữ đã thật sự vào ô.
   *
   * `keyboard.type` gõ vào phần tử ĐANG có focus, không phải vào `loc`. Click trượt, hoặc
   * Google re-render/đổi focus giữa lúc gõ, là toàn bộ ký tự rơi ra ngoài — hàm vẫn trả về
   * êm ru, rồi bước sau submit ô rỗng.
   *
   * Đã mất một lượt login đúng như thế: màn "Welcome" của agyproxy56 chụp lại được cảnh ô
   * mật khẩu trống kèm lỗi "Enter a password". Không có kiểm tra này thì lỗi im lặng, chỉ
   * lộ ra khi mở ảnh — mà mỗi lần như vậy tốn một lượt trong trần login/24h.
   */
  const daVao = await loc.inputValue().catch(() => null);
  if (daVao === null || daVao === text) return; // null = ô không đọc được giá trị, bỏ qua

  // timeout ngắn: fill() mặc định chờ 30s cho ô "editable" — ô readonly sẽ treo cả flow.
  await loc.fill(text, { timeout: 5000 }).catch(() => {});
  const lanHai = await loc.inputValue().catch(() => null);
  if (lanHai !== null && lanHai !== text) {
    throw new Error(`Gõ vào ô không ăn: mong ${text.length} ký tự, ô có ${lanHai.length}`);
  }
}

/** Cuộn trang từng nấc nhỏ có nghỉ (dùng cho màn hình consent dài). */
export async function humanScroll(page: Page, totalPx = 600): Promise<void> {
  let scrolled = 0;
  while (scrolled < totalPx) {
    const step = rand(80, 200);
    await page.mouse.wheel(0, step);
    scrolled += step;
    await sleep(rand(150, 450));
  }
}
