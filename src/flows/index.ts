import type { FlowKey } from '../store/models.js';
import { runFlow, type FlowFn } from './runner.js';
import { googleLoginFlow } from './googleLogin.js';
import { geminiWebFlow } from './geminiWeb.js';
import { antigravityFlow, geminiCliFlow } from './oauthProvider.js';
import { kiroFlow } from './kiro.js';

export const FLOWS: Record<FlowKey, FlowFn> = {
  google: googleLoginFlow,
  gweb: geminiWebFlow,
  agy: antigravityFlow,
  gcli: geminiCliFlow,
  kiro: kiroFlow,
};

/**
 * Thứ tự pipeline cho 1 account — 2 LUỒNG: antigravity + kiro.
 * Cả hai tự đăng nhập Google NGAY trong link OAuth (không cần flow google/gweb
 * riêng, không dính cap login/24h của flow google). google & gweb để làm sau
 * (flow vẫn còn trong FLOWS, chạy tay được nếu cần).
 *
 * ĐÃ BỎ agycli khỏi pipeline — ĐO ĐƯỢC là nó KHÔNG thêm hạn mức:
 *  - agy và agycli của CÙNG account trỏ về CÙNG projectId, cùng %, cùng giờ reset
 *    (quota Antigravity gắn theo account/project, KHÔNG theo token);
 *  - account khác nhau mới có project + quota khác nhau;
 *  - pool gateway chỉ nạp credential target 'agy' (providers/agy.ts credentialTarget)
 *    nên token agycli không hề tham gia xoay vòng.
 * Đổi lại, chạy nó tốn GẤP ĐÔI lượt đăng nhập Google mỗi account → tăng rủi ro
 * checkpoint, trong khi OmniRoute còn cảnh báo provider này "dùng nhiều dễ bị ban".
 * Vẫn giữ trong FLOWS để chạy tay khi cần connection bên OmniRoute.
 */
export const PIPELINE: FlowKey[] = ['agy', 'kiro'];

export async function runSingle(email: string, flow: FlowKey, opts?: { noProxy?: boolean }) {
  return runFlow(email, flow, FLOWS[flow], opts);
}
