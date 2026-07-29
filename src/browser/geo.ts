/**
 * Map quốc gia proxy -> geo coherent (timezone/locale/ngôn ngữ/toạ độ) để
 * IP ↔ timezone ↔ locale ↔ fingerprint language đồng nhất, tránh mismatch.
 * Tên quốc gia lấy từ ip-api.com (field country) qua testProxy.
 */

export interface GeoProfile {
  timezoneId: string;
  locale: string;
  languages: string[];
  geolocation: { latitude: number; longitude: number };
}

const MAP: Record<string, GeoProfile> = {
  'United Kingdom': { timezoneId: 'Europe/London', locale: 'en-GB', languages: ['en-GB', 'en'], geolocation: { latitude: 51.5074, longitude: -0.1278 } },
  'United States': { timezoneId: 'America/New_York', locale: 'en-US', languages: ['en-US', 'en'], geolocation: { latitude: 40.7128, longitude: -74.006 } },
  Vietnam: { timezoneId: 'Asia/Ho_Chi_Minh', locale: 'vi-VN', languages: ['vi-VN', 'vi', 'en'], geolocation: { latitude: 21.0278, longitude: 105.8342 } },
  Singapore: { timezoneId: 'Asia/Singapore', locale: 'en-SG', languages: ['en-SG', 'en'], geolocation: { latitude: 1.3521, longitude: 103.8198 } },
  Japan: { timezoneId: 'Asia/Tokyo', locale: 'ja-JP', languages: ['ja-JP', 'ja', 'en'], geolocation: { latitude: 35.6762, longitude: 139.6503 } },
  Germany: { timezoneId: 'Europe/Berlin', locale: 'de-DE', languages: ['de-DE', 'de', 'en'], geolocation: { latitude: 52.52, longitude: 13.405 } },
  France: { timezoneId: 'Europe/Paris', locale: 'fr-FR', languages: ['fr-FR', 'fr', 'en'], geolocation: { latitude: 48.8566, longitude: 2.3522 } },
  Netherlands: { timezoneId: 'Europe/Amsterdam', locale: 'nl-NL', languages: ['nl-NL', 'nl', 'en'], geolocation: { latitude: 52.3676, longitude: 4.9041 } },
  Canada: { timezoneId: 'America/Toronto', locale: 'en-CA', languages: ['en-CA', 'en'], geolocation: { latitude: 43.6532, longitude: -79.3832 } },
  Australia: { timezoneId: 'Australia/Sydney', locale: 'en-AU', languages: ['en-AU', 'en'], geolocation: { latitude: -33.8688, longitude: 151.2093 } },
  India: { timezoneId: 'Asia/Kolkata', locale: 'en-IN', languages: ['en-IN', 'en', 'hi'], geolocation: { latitude: 28.6139, longitude: 77.209 } },
  'Hong Kong': { timezoneId: 'Asia/Hong_Kong', locale: 'zh-HK', languages: ['zh-HK', 'zh', 'en'], geolocation: { latitude: 22.3193, longitude: 114.1694 } },
  Thailand: { timezoneId: 'Asia/Bangkok', locale: 'th-TH', languages: ['th-TH', 'th', 'en'], geolocation: { latitude: 13.7563, longitude: 100.5018 } },
  Indonesia: { timezoneId: 'Asia/Jakarta', locale: 'id-ID', languages: ['id-ID', 'id', 'en'], geolocation: { latitude: -6.2088, longitude: 106.8456 } },
};

const DEFAULT: GeoProfile = MAP.Vietnam!;

export function geoForCountry(country: string | undefined): GeoProfile | undefined {
  if (!country) return undefined;
  return MAP[country];
}

export { DEFAULT as DEFAULT_GEO };
