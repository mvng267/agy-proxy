import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';

/**
 * Cấu hình React Query dùng chung.
 *
 * Giải các vấn đề của cách cũ (mỗi trang tự useEffect + setInterval):
 *  - Poll chạy cả khi tab ẩn        → refetchIntervalInBackground: false
 *  - Chuyển tab là mất state, fetch lại từ đầu → cache + staleTime
 *  - Poll GHI ĐÈ kết quả thao tác thủ công vừa xong → invalidate thay vì setState
 *  - Retry vô ích khi 401/403       → retry có điều kiện
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      refetchIntervalInBackground: false,
      retry: (count, err) => {
        const s = err instanceof ApiError ? err.status : 0;
        if (s === 401 || s === 403 || s === 404) return false;
        return count < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});

/**
 * Nhịp poll theo TỐC ĐỘ THAY ĐỔI của dữ liệu, không theo trang.
 * Trước đây mỗi trang tự chọn (15s/30s/60s/không poll) mà không có lý do rõ ràng.
 */
export const POLL = {
  live: 10_000, // pool, trạng thái account — đổi liên tục
  normal: 30_000, // overview, combo, connections
  slow: 60_000, // usage, models — đổi chậm
} as const;
