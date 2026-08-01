import type { FlowKey } from '../store/models.js';
import { runFlow, type FlowFn } from './runner.js';
import { googleLoginFlow } from './googleLogin.js';
import { geminiWebFlow } from './geminiWeb.js';
import { antigravityFlow, antigravityCliFlow, geminiCliFlow } from './oauthProvider.js';
import { kiroFlow } from './kiro.js';

export const FLOWS: Record<FlowKey, FlowFn> = {
  google: googleLoginFlow,
  gweb: geminiWebFlow,
  agy: antigravityFlow,
  agycli: antigravityCliFlow,
  gcli: geminiCliFlow,
  kiro: kiroFlow,
};

/**
 * Thứ tự pipeline cho 1 account — HIỆN TẠI 3 LUỒNG: antigravity + antigravity-cli + kiro.
 * Cả ba tự đăng nhập Google NGAY trong link OAuth (không cần flow google/gweb
 * riêng, không dính cap login/24h của flow google). google & gweb để làm sau
 * (flow vẫn còn trong FLOWS, chạy tay được nếu cần).
 *
 * agycli đăng ký vào provider "Antigravity CLI" RIÊNG trong OmniRoute (slug "agy",
 * khác "antigravity") — OmniRoute tự cảnh báo provider này "không dành cho dùng
 * proxy/router, dùng nhiều dễ bị hạn chế/ban account". Bật theo yêu cầu, cân nhắc
 * theo dõi health/ban rate trước khi chạy đại trà.
 */
export const PIPELINE: FlowKey[] = ['agy', 'agycli', 'kiro'];

export async function runSingle(email: string, flow: FlowKey, opts?: { noProxy?: boolean }) {
  return runFlow(email, flow, FLOWS[flow], opts);
}
