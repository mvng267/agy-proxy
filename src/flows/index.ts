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
 * Thứ tự pipeline cho 1 account — HIỆN TẠI CHỈ 2 LUỒNG: antigravity + kiro.
 * Cả hai tự đăng nhập Google NGAY trong link OAuth (không cần flow google/gweb
 * riêng, không dính cap login/24h của flow google). google & gweb để làm sau
 * (flow vẫn còn trong FLOWS, chạy tay được nếu cần).
 */
export const PIPELINE: FlowKey[] = ['agy', 'kiro'];

export async function runSingle(email: string, flow: FlowKey, opts?: { noProxy?: boolean }) {
  return runFlow(email, flow, FLOWS[flow], opts);
}
